/**
 * The beta report, as a library (roadmap M4/M6): collecting, classifying,
 * judging and formatting. Used by the command (scripts/beta-report.js) and by
 * the server's own scheduler (server/betaMonitor.js), so a stored daily report
 * and a report a person runs by hand are the same computation.
 *
 * Read-only. It fixes nothing: a report that repaired its own input could not
 * be evidence about the thing it repaired.
 *
 * Three verdicts, kept apart on purpose:
 *   status          the counts (M4) AND whether the measurement was observably
 *                   running for the whole report window. No evidence, a gap, a
 *                   degraded event or a failed query can never be PASS.
 *   observation72h  the last 72 hours before `to`: continuous evidence, and
 *                   real usage inside it ("no games" is not "no problems").
 *   gate            PASS only when both of the above pass. Still not a release
 *                   decision — see `limits`.
 */

const { classifyGames, summarise, verdict, recoverySummary } = require('./betaMetrics');
const { sslConfigFor } = require('./dbTls');
const { observe, HOUR_MS } = require('./observation');

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * The pg client configuration for a report connection: exactly the server's TLS
 * decision. Throws for an address whose target is ambiguous — the caller exits
 * rather than connecting somewhere it cannot vouch for.
 */
function clientConfig(url, env = process.env) {
  const cfg = sslConfigFor(url, env);
  return { connectionString: cfg.connectionString, ssl: cfg.ssl };
}

async function collect(client, { from, to, cohort, release, environment, trafficKind }) {
  // Which games the window owns: decided by the START event alone, so a long
  // game cannot fall out of every window.
  const started = await client.query(
    `SELECT game_id FROM telemetry_events
      WHERE event_type = 'game_started'
        AND ($1::text IS NULL OR traffic_kind = $1)
        AND ($2::timestamptz IS NULL OR server_occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR server_occurred_at < $3)
        AND ($4::text IS NULL OR beta_cohort_id = $4)
        AND ($5::text IS NULL OR release_sha = $5)
        AND ($6::text IS NULL OR environment = $6)
        AND game_id IS NOT NULL`,
    [trafficKind, from, to, cohort, release, environment]);
  const gameIds = [...new Set(started.rows.map((r) => r.game_id))];

  const events = gameIds.length
    ? (await client.query(
      `SELECT event_id, event_type, game_id, attempt_id, seat, source, reason_code,
              details, traffic_kind, environment, beta_cohort_id, release_sha,
              process_instance_id, server_occurred_at
         FROM telemetry_events WHERE game_id = ANY($1)`, [gameIds])).rows
    : [];

  // A process that started and never said it was stopping is either still up or
  // was killed. The DB cannot tell which, so a game on such a process counts as
  // in progress (P) and the report says that this is an approximation.
  const processes = await client.query(
    `SELECT process_instance_id,
            bool_or(event_type = 'process_stopping') AS stopped
       FROM telemetry_events GROUP BY process_instance_id`);
  const liveProcesses = new Set(processes.rows.filter((r) => !r.stopped)
    .map((r) => r.process_instance_id));

  const degraded = await client.query(
    `SELECT count(*)::int AS n FROM telemetry_events
      WHERE event_type IN ('telemetry_degraded', 'telemetry_conflict')
        AND ($1::timestamptz IS NULL OR server_occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR server_occurred_at < $2)`, [from, to]);

  // The stored results for exactly these games. Without them no game can be C:
  // "the row the policy called for is there" is part of C, and the first version
  // of this report decided it from the match_persisted EVENT and never read the
  // table — with every row missing it said PASS with C=100. If this query fails,
  // collect() throws and the report is an OBSERVABILITY_GAP, not a pass.
  const matchRows = gameIds.length
    ? (await client.query(
      `SELECT id, match_uid, player_a, player_b, score_a, score_b, winner_id, played_at
         FROM matches WHERE match_uid = ANY($1)`, [gameIds])).rows
    : [];

  // Positive evidence that the measurement was running (roadmap M6): the
  // heartbeats and process lifecycle events, plus its own fault events, for the
  // window and a little before it — a heartbeat just before `from` covers the
  // start of the window.
  const evidenceFrom = from ? new Date(from.getTime() - 3 * 24 * 60 * 60 * 1000) : null;
  const evidence = (await client.query(
    `SELECT event_type, server_occurred_at, details FROM telemetry_events
      WHERE event_type IN ('telemetry_heartbeat', 'process_started', 'process_stopping',
                           'telemetry_degraded', 'telemetry_conflict')
        AND ($1::timestamptz IS NULL OR server_occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR server_occurred_at < $2)
      ORDER BY server_occurred_at`, [evidenceFrom, to])).rows;

  return {
    gameIds,
    events,
    matchRows,
    liveProcesses,
    evidence,
    degradedEvents: degraded.rows[0].n,
  };
}


/** The heartbeat interval the server said it used; the configured default otherwise. */
function heartbeatIntervalOf(evidence, fallbackMs = DEFAULT_HEARTBEAT_MS) {
  const recorded = evidence
    .filter((e) => e.event_type === 'telemetry_heartbeat' && e.details && Number(e.details.interval_ms) > 0)
    .map((e) => Number(e.details.interval_ms));
  return recorded.length ? Math.max(...recorded) : fallbackMs;
}

/**
 * Computes a whole report. Never throws for a database failure: that becomes
 * `queryFailed` and an OBSERVABILITY_GAP status, because a report that errors
 * out is easy to mistake for a report that was never scheduled.
 */
async function buildReport(client, scope, {
  now = new Date(), minGames = 100, minTechnicalPct = 98, heartbeatMs,
} = {}) {
  const to = scope.to || now;
  let data = null;
  let failure = null;
  try {
    data = await collect(client, { ...scope, to });
  } catch (err) {
    failure = err.message;
  }

  const classified = data
    ? classifyGames(data.events, { liveProcesses: data.liveProcesses, matchRows: data.matchRows })
    : new Map();
  const summary = summarise(classified);
  const counts = verdict(summary, {
    minGames, minTechnicalPct, degradedEvents: data ? data.degradedEvents : 0, queryFailed: Boolean(failure),
  });

  const evidence = data ? data.evidence : [];
  const interval = heartbeatMs || heartbeatIntervalOf(evidence);
  // The report window itself must have been observed; an open window is
  // judged from its earliest evidence.
  const firstEvidence = evidence.length ? new Date(evidence[0].server_occurred_at) : to;
  const windowFrom = scope.from || firstEvidence;
  const windowObs = data
    ? observe(evidence, { from: windowFrom, to, now, heartbeatMs: interval })
    : { status: 'INSUFFICIENT_DATA', gaps: [], note: 'query failed' };

  const obs72From = new Date(to.getTime() - 72 * HOUR_MS);
  const obs72 = data
    ? observe(evidence, { from: obs72From, to, now, heartbeatMs: interval })
    : { status: 'INSUFFICIENT_DATA', gaps: [], note: 'query failed' };
  // Real usage inside those 72 hours: a quiet window is not a passing one.
  const usage72 = data ? data.events.filter((e) => e.event_type === 'game_started'
    && new Date(e.server_occurred_at) >= obs72From).length : 0;
  const observation72h = {
    ...obs72,
    games: usage72,
    status: obs72.status === 'COVERED' && usage72 === 0 ? 'NO_USAGE' : obs72.status,
  };

  let status = counts.status;
  const notes = [...counts.notes];
  if (status === 'PASS' && windowObs.status !== 'COVERED') {
    status = windowObs.status === 'GAP' ? 'OBSERVABILITY_GAP' : 'INSUFFICIENT_DATA';
    notes.push(windowObs.status === 'GAP'
      ? `rapor penceresinde ${windowObs.gaps.length} gözlem boşluğu var`
      : `rapor penceresinin gözlemi doğrulanamadı (${windowObs.note || 'kanıt yok'})`);
  }
  if (failure) notes.push(`sorgu hatası: ${failure}`);
  const gate = status === 'PASS' && observation72h.status === 'COVERED' ? 'PASS' : 'NOT_PASSED';

  return {
    scope: {
      ...scope,
      asOf: now.toISOString(),
      from: scope.from ? scope.from.toISOString() : null,
      to: to.toISOString(),
    },
    status,
    gate,
    queryFailed: Boolean(failure),
    notes,
    summary,
    games: [...classified.entries()].map(([gameId, value]) => ({ gameId, ...value })),
    recovery: data ? recoverySummary(data.events) : null,
    degradedEvents: data ? data.degradedEvents : 0,
    observation: { window: windowObs, last72h: observation72h, heartbeatMs: interval },
    limits: [
      'Aynı yanlış sonucun hem olaya hem satıra yazılması bu raporla yakalanamaz; '
        + 'pozitif/negatif cevap testleri ve kullanıcı bildirimi ayrıca gerekir.',
      'İnsan trafiği, sunucunun trafiği human_beta olarak etiketlemesine dayanır; '
        + 'bu bir "kesin insan tespiti" değildir.',
      'P sınıfı bir yaklaşıklıktır: process_stopping olayı olmayan bir süreç ya yaşıyordur '
        + 'ya da öldürülmüştür, veritabanı ikisini ayırt edemez.',
      'Gözlem sürekliliği sunucunun kendi kalp atışlarına dayanır; dış erişilebilirlik izlemesinin yerine geçmez.',
      'PASS ve gate yalnız bu sayılar hakkındadır; yayın kararı değildir. Güvenlik testleri ve açık bulgu listesi ayrıca gerekir.',
    ],
  };
}

function markdown(report) {
  const { scope, summary, status, notes, recovery, degradedEvents, limits, observation, gate } = report;
  const pct = (value) => (value === null ? 'hesaplanamadı' : `%${value}`);
  const lines = [
    `# Beta ölçüm raporu — ${status}`,
    '',
    `* as_of: ${scope.asOf}`,
    `* pencere (başlangıç zamanına göre, [from, to)): ${scope.from || 'açık'} → ${scope.to || 'açık'}`,
    `* grup: ${scope.cohort || 'hepsi'} · sürüm: ${scope.release || 'hepsi'} · ortam: ${scope.environment || 'hepsi'}`,
    `* trafik türü: ${scope.trafficKind}`,
    '',
    '## Sayılar',
    '',
    '| Sınıf | Anlamı | Sayı |',
    '|---|---|---|',
    `| H | başlatılmış tekil maç | ${summary.H} |`,
    `| C | tamamlandı (sunucu sonucu + iki ekran bildirimi + skor tutarlı + beklenen kayıt) | ${summary.counts.C} |`,
    `| V | bilinçli terk (teknik hata/kopma öncesinde yok) | ${summary.counts.V} |`,
    `| P | hâlâ devam ediyor | ${summary.counts.P} |`,
    `| F | teknik hata veya tutarlılık kontrolü başarısız | ${summary.counts.F} |`,
    `| U | kanıt eksik / nedeni açıklanamıyor | ${summary.counts.U} |`,
    '',
    `* toplam tamamlanma C/H: ${pct(summary.totalCompletionPct)} (${summary.counts.C}/${summary.H})`,
    `* teknik tamamlanma C/(H−V): ${pct(summary.technicalCompletionPct)} `
      + `(${summary.counts.C}/${summary.technicalDenominator})`,
    '',
    '## Sınıflandırma gerekçeleri',
    '',
    ...Object.entries(summary.reasons).sort().map(([reason, n]) => `* ${reason}: ${n}`),
    '',
    '## Kopma / recovery (bölüm başına; tekrar teslim tek sayılır)',
    '',
    recovery && recovery.episodes
      ? [
        `* kopma bölümü: ${recovery.episodes}`,
        `* geri döndü ve güncel faz ekranda doğrulandı: ${recovery.recoveredVisible}`,
        `* geri döndü ama ekran doğrulanmadı: ${recovery.recoveredNotConfirmed}`,
        `* süre aşıldı: ${recovery.windowExpired} · oda yoktu: ${recovery.roomGone}`,
        `* sonucu yok: ${recovery.unresolved} · çelişkili: ${recovery.contradictory}`,
      ].join('\n')
      : '* bu kapsamda kopma olayı yok',
    '',
    '## Gözlem sağlığı',
    '',
    `* rapor penceresi: ${observation ? observation.window.status : 'bilinmiyor'}`
      + (observation && observation.window.gaps.length ? ` (${observation.window.gaps.length} boşluk)` : ''),
    `* son 72 saat: ${observation ? observation.last72h.status : 'bilinmiyor'}`
      + (observation ? ` · bu sürede başlayan maç: ${observation.last72h.games}` : ''),
    `* kapı (gate): ${gate || 'NOT_PASSED'}`,
    `* ölçüm arıza/çelişki olayı: ${degradedEvents}`,
    `* durum notları: ${notes.join('; ') || 'yok'}`,
    '',
    '## Bu raporun kanıtlamadıkları',
    '',
    ...limits.map((l) => `* ${l}`),
    '',
  ];
  return lines.join('\n');
}


module.exports = { collect, buildReport, markdown, clientConfig, heartbeatIntervalOf };
