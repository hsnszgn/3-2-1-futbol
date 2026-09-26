#!/usr/bin/env node
/**
 * The beta report (roadmap M4/M6). Read-only.
 *
 *   npm run beta:report -- --from 2026-10-01T00:00:00Z --to 2026-10-08T00:00:00Z \
 *     --cohort beta-01 --release <sha> --format markdown
 *
 * Reads the measurement events and prints the counts, the two completion ratios
 * and a status. It writes nothing and fixes nothing: a report that repairs its
 * own input cannot be used as evidence about the thing it repaired.
 *
 * The connection string comes from the environment (REPORT_DATABASE_URL, falling
 * back to DATABASE_URL), never from the command line, so it does not end up in a
 * shell history or a CI log. A read-only database user is the intended way to run
 * this.
 *
 * Deliberate properties, each of them a way this report could otherwise lie:
 *
 *  * Scope is by START time, `[from, to)`. A game that runs past `to` still
 *    belongs to the window it started in, so the denominator cannot be trimmed
 *    by choosing when to stop looking.
 *  * `as_of` is printed. Events can arrive late; the same window recomputed
 *    later may say something different, and the reader has to be able to see
 *    which run they are holding.
 *  * A failed query or a degraded measurement is OBSERVABILITY_GAP, never PASS
 *    with empty numbers.
 *  * Percentages are never printed without the raw counts beside them.
 */

const { Client } = require('pg');
const { classifyGames, summarise, verdict } = require('../server/betaMetrics');

function parseArgs(argv) {
  const args = { format: 'markdown' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i += 1] : 'true';
    args[key] = value;
  }
  return args;
}

function isoOrNull(value, label) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--${label} is not a date: ${value}`);
  return date;
}

async function collect(client, { from, to, cohort, release, environment, trafficKind }) {
  // Which games the window owns: decided by the START event alone, so a long
  // game cannot fall out of every window.
  const started = await client.query(
    `SELECT game_id FROM telemetry_events
      WHERE event_type = 'game_started'
        AND traffic_kind = $1
        AND ($2::timestamptz IS NULL OR server_occurred_at >= $2)
        AND ($3::timestamptz IS NULL OR server_occurred_at < $3)
        AND ($4::text IS NULL OR beta_cohort_id = $4)
        AND ($5::text IS NULL OR release_sha = $5)
        AND ($6::text IS NULL OR environment = $6)
        AND game_id IS NOT NULL`,
    [trafficKind, from, to, cohort, release, environment]);
  const gameIds = started.rows.map((r) => r.game_id);

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

  const recovery = await client.query(
    `SELECT reason_code, count(*)::int AS n FROM telemetry_events
      WHERE event_type = 'recovery_finished'
        AND ($1::timestamptz IS NULL OR server_occurred_at >= $1)
        AND ($2::timestamptz IS NULL OR server_occurred_at < $2)
      GROUP BY reason_code ORDER BY reason_code`, [from, to]);

  return {
    events,
    liveProcesses,
    degradedEvents: degraded.rows[0].n,
    recovery: recovery.rows,
    // Episodes, not replays: a disconnect id repeated by Socket.IO's own retries
    // must not raise the count of controlled interruptions.
    recoveryEpisodes: new Set(events
      .filter((e) => e.event_type === 'recovery_finished' && e.details && e.details.episode_id)
      .map((e) => e.details.episode_id)).size,
  };
}

function markdown(report) {
  const { scope, summary, status, notes, recovery, degradedEvents, limits } = report;
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
    '## Kopma / recovery',
    '',
    recovery.length
      ? recovery.map((r) => `* ${r.reason_code || 'bilinmiyor'}: ${r.n}`).join('\n')
      : '* bu pencerede kopma olayı yok',
    '',
    '## Gözlem sağlığı',
    '',
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.REPORT_DATABASE_URL || process.env.DATABASE_URL || '';
  if (!url) {
    console.error('REPORT_DATABASE_URL (or DATABASE_URL) is required; the connection string is '
      + 'never taken from the command line.');
    process.exit(2);
  }

  const scope = {
    asOf: new Date().toISOString(),
    from: isoOrNull(args.from, 'from'),
    to: isoOrNull(args.to, 'to'),
    cohort: args.cohort || null,
    release: args.release || null,
    environment: args.environment || null,
    // Only real beta traffic counts towards H. Overridable for inspection, but
    // the default is the one the gate is about.
    trafficKind: args['traffic-kind'] || 'human_beta',
  };

  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
  });

  let data = null;
  let queryFailed = false;
  let failure = null;
  try {
    await client.connect();
    data = await collect(client, scope);
  } catch (err) {
    queryFailed = true;
    failure = err.message;
  } finally {
    await client.end().catch(() => {});
  }

  const classified = data ? classifyGames(data.events, { liveProcesses: data.liveProcesses })
    : new Map();
  const summary = summarise(classified);
  const decision = verdict(summary, {
    minGames: Number(args['min-games'] || 100),
    minTechnicalPct: Number(args['min-technical'] || 98),
    degradedEvents: data ? data.degradedEvents : 0,
    queryFailed,
  });

  const report = {
    scope: {
      ...scope,
      from: scope.from ? scope.from.toISOString() : null,
      to: scope.to ? scope.to.toISOString() : null,
    },
    status: decision.status,
    notes: failure ? [...decision.notes, `sorgu hatası: ${failure}`] : decision.notes,
    summary,
    games: [...classified.entries()].map(([gameId, value]) => ({ gameId, ...value })),
    recovery: data ? data.recovery : [],
    recoveryEpisodes: data ? data.recoveryEpisodes : 0,
    degradedEvents: data ? data.degradedEvents : 0,
    limits: [
      'Aynı yanlış sonucun hem olaya hem satıra yazılması bu raporla yakalanamaz; '
        + 'pozitif/negatif cevap testleri ve kullanıcı bildirimi ayrıca gerekir.',
      'İnsan trafiği, sunucunun trafiği human_beta olarak etiketlemesine dayanır; '
        + 'bu bir "kesin insan tespiti" değildir.',
      'P sınıfı bir yaklaşıklıktır: process_stopping olayı olmayan bir süreç ya yaşıyordur '
        + 'ya da öldürülmüştür, veritabanı ikisini ayırt edemez.',
      'PASS yalnız bu sayılar hakkındadır; yayın kararı değildir.',
    ],
  };

  if ((args.format || 'markdown') === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown(report));
  }
  // A non-zero exit for anything that is not a pass, so a scheduler notices.
  process.exit(decision.status === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`beta-report failed: ${err && err.stack}`);
    process.exit(2);
  });
}

module.exports = { parseArgs, collect, markdown };
