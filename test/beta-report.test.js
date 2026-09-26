/**
 * The beta numbers and the reconciliation (roadmap M4/M5/M7). Needs a real,
 * isolated PostgreSQL.
 *
 * Two halves, and the split is deliberate:
 *
 *   1. The formulas, driven with SYNTHETIC events written straight into the
 *      table. These are not real games and are never presented as any: the point
 *      is that the spec's own worked example (H=110, V=10, P=0, C=98, F=1, U=1)
 *      comes out exactly, and that an empty window is "could not be computed"
 *      rather than 100%.
 *   2. The two commands as a reader would run them — spawned, with the
 *      connection string in the environment and never on the command line —
 *      against a small set of games that each carry one defect.
 *
 * What is being defended against here is a report that reads as success: a zero
 * denominator printed as a pass, a missing result screen counted as complete, a
 * score that does not add up going unnoticed, a row nobody can explain being
 * assumed fine.
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { classifyGames, summarise, verdict } = require('../server/betaMetrics');
const { reconcile } = require('../scripts/check-match-integrity');

const REPORT = path.join(__dirname, '..', 'scripts', 'beta-report.js');
const INTEGRITY = path.join(__dirname, '..', 'scripts', 'check-match-integrity.js');

const PROCESS_LIVE = 'proc-live';
const PROCESS_GONE = 'proc-gone';

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** One event row, with the contract's required columns filled in. */
function event(overrides) {
  return {
    event_id: `e-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    schema_version: 1,
    event_type: 'game_started',
    game_id: null,
    attempt_id: null,
    seat: null,
    server_occurred_at: new Date('2026-10-02T12:00:00Z'),
    environment: 'beta',
    traffic_kind: 'human_beta',
    beta_cohort_id: 'beta-01',
    release_sha: 'sha-1',
    process_instance_id: PROCESS_GONE,
    source: 'server',
    reason_code: null,
    details: {},
    ...overrides,
  };
}

/**
 * A complete game: started, both rounds scored, finished with the matching
 * score, both result screens reported, and the recording decision taken.
 */
function completeGame(gameId, { score = [3, 1], persist = false } = {}) {
  const rows = [
    event({ game_id: gameId, event_type: 'game_started', details: { mode: 'duel', max_rounds: 2 } }),
    event({
      game_id: gameId, event_type: 'round_scored', attempt_id: 1, seat: 'A',
      details: { round: 1, points: score[0], scored_seat: 'A', outcome: 'answered' },
    }),
    event({
      game_id: gameId, event_type: 'round_scored', attempt_id: 2, seat: 'B',
      details: { round: 2, points: score[1], scored_seat: 'B', outcome: 'answered' },
    }),
    event({
      game_id: gameId, event_type: 'game_finished',
      details: {
        score_a: score[0], score_b: score[1], rounds_played: 2,
        winner_seat: score[0] === score[1] ? 'draw' : (score[0] > score[1] ? 'A' : 'B'),
      },
    }),
    event({
      game_id: gameId, event_type: 'recording_decided',
      reason_code: persist ? 'both_signed_in' : 'guest_seat',
      details: { decision: persist ? 'persist' : 'skip', policy: 'both_signed_in' },
    }),
    event({ game_id: gameId, event_type: 'result_rendered', seat: 'A', source: 'client', details: { round: 2 } }),
    event({ game_id: gameId, event_type: 'result_rendered', seat: 'B', source: 'client', details: { round: 2 } }),
  ];
  if (persist) {
    rows.push(event({ game_id: gameId, event_type: 'match_persisted', details: { match_uid: gameId } }));
  }
  return rows;
}

function leftGame(gameId) {
  return [
    event({ game_id: gameId, event_type: 'game_started', details: { mode: 'duel', max_rounds: 2 } }),
    event({
      game_id: gameId, event_type: 'game_aborted', seat: 'A', reason_code: 'left',
      details: { round: 1, rounds_played: 1 },
    }),
  ];
}

function brokenGame(gameId) {
  return [
    event({ game_id: gameId, event_type: 'game_started', details: { mode: 'duel', max_rounds: 2 } }),
    event({
      game_id: gameId, event_type: 'disconnect_observed', seat: 'B', reason_code: 'transport_close',
      details: { phase: 'player-submit', round: 1 },
    }),
    event({
      game_id: gameId, event_type: 'game_aborted', reason_code: 'recovery_expired',
      details: { round: 1, rounds_played: 1 },
    }),
  ];
}

/** Finished, but only one screen reported it: unprovable, so U. */
function unprovenGame(gameId) {
  return completeGame(gameId).filter((row) => !(row.event_type === 'result_rendered' && row.seat === 'B'));
}

async function insert(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO telemetry_events (event_id, schema_version, event_type, game_id, attempt_id,
        seat, server_occurred_at, environment, traffic_kind, beta_cohort_id, release_sha,
        process_instance_id, source, reason_code, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [row.event_id, row.schema_version, row.event_type, row.game_id, row.attempt_id, row.seat,
        row.server_occurred_at, row.environment, row.traffic_kind, row.beta_cohort_id,
        row.release_sha, row.process_instance_id, row.source, row.reason_code,
        JSON.stringify(row.details)]);
  }
}

module.exports = async function run_({ databaseUrl }) {
  const notes = [];
  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    // --- 1. the spec's worked example, exactly -----------------------------
    {
      const events = [];
      for (let i = 0; i < 98; i += 1) events.push(...completeGame(`ok-${i}`));
      for (let i = 0; i < 10; i += 1) events.push(...leftGame(`left-${i}`));
      events.push(...brokenGame('broken-1'));
      events.push(...unprovenGame('unproven-1'));

      const classified = classifyGames(events, { liveProcesses: new Set() });
      const summary = summarise(classified);
      assert.strictEqual(summary.H, 110, `H is ${summary.H}`);
      assert.deepStrictEqual(summary.counts, { C: 98, V: 10, P: 0, F: 1, U: 1 },
        `classes came out as ${JSON.stringify(summary.counts)}`);
      assert.strictEqual(summary.technicalCompletionPct, 98,
        `technical completion is ${summary.technicalCompletionPct}`);
      assert.strictEqual(summary.totalCompletionPct, 89.09,
        `total completion is ${summary.totalCompletionPct}`);
      // The threshold is met and the gate still does not open, because one game
      // is unexplained. This is the case the roadmap calls out by name.
      const decision = verdict(summary, { minGames: 100, minTechnicalPct: 98 });
      assert.strictEqual(decision.status, 'FAIL',
        `an unexplained U passed the gate: ${JSON.stringify(decision)}`);
      assert.ok(decision.notes.join(' ').includes('belirsiz'), decision.notes.join(' '));
      notes.push('şartnamedeki örnek birebir çıktı: H=110, C=98, V=10, P=0, F=1, U=1, '
        + 'teknik %98, toplam %89.09 — ve açıklanmamış U yüzünden karar FAIL');
    }

    // --- 2. an empty window is not a pass ----------------------------------
    {
      const summary = summarise(classifyGames([], {}));
      assert.strictEqual(summary.H, 0);
      assert.strictEqual(summary.totalCompletionPct, null, 'an empty window produced a percentage');
      assert.strictEqual(summary.technicalCompletionPct, null, 'an empty window produced a percentage');
      assert.strictEqual(verdict(summary, {}).status, 'INSUFFICIENT_DATA');
      // And a window in which the measurement itself broke says so, whatever the
      // games did.
      const degraded = verdict(summarise(classifyGames(
        Array.from({ length: 120 }, (_, i) => completeGame(`g${i}`)).flat(), {})),
      { degradedEvents: 1 });
      assert.strictEqual(degraded.status, 'OBSERVABILITY_GAP',
        `a degraded measurement still returned ${degraded.status}`);
      notes.push('boş pencere: yüzde üretilmiyor (null), durum INSUFFICIENT_DATA; '
        + '120 tamamlanmış maç varken tek ölçüm arızası OBSERVABILITY_GAP');
    }

    // --- 3. in progress is in progress, not complete and not lost ----------
    {
      const events = [
        event({ game_id: 'live-1', process_instance_id: PROCESS_LIVE }),
        event({ game_id: 'dead-1', process_instance_id: PROCESS_GONE }),
      ];
      const classified = classifyGames(events, { liveProcesses: new Set([PROCESS_LIVE]) });
      assert.strictEqual(classified.get('live-1').klass, 'P');
      assert.strictEqual(classified.get('dead-1').klass, 'U');
      assert.strictEqual(classified.get('dead-1').reason, 'no_final_event');
      // P blocks a final verdict rather than being rounded away.
      const decision = verdict(summarise(classified), { minGames: 1 });
      assert.strictEqual(decision.status, 'INSUFFICIENT_DATA');
      notes.push('yaşayan süreçteki bitmemiş maç P, ölmüş süreçteki bitmemiş maç U '
        + '(paydadan silinmiyor); P>0 nihai kararı engelliyor');
    }

    // --- 3b. explicit leave, network loss and an unknown end stay apart ----
    // A player who leaves BECAUSE the game broke is not a voluntary abandonment.
    // Counting them as V would take a broken game out of the technical
    // denominator — the ratio would rise by hiding the fault.
    {
      const events = [
        ...leftGame('clean-leave'),
        // the same leave, after a disconnection
        event({ game_id: 'leave-after-drop', event_type: 'game_started' }),
        event({ game_id: 'leave-after-drop', event_type: 'disconnect_observed', seat: 'A', reason_code: 'unknown' }),
        event({ game_id: 'leave-after-drop', event_type: 'game_aborted', seat: 'A', reason_code: 'left' }),
        // the same leave, after a server error
        event({ game_id: 'leave-after-error', event_type: 'game_started' }),
        event({ game_id: 'leave-after-error', event_type: 'server_error', details: { error_kind: 'x' } }),
        event({ game_id: 'leave-after-error', event_type: 'game_aborted', seat: 'A', reason_code: 'left' }),
        // the network went, the window ran out
        ...brokenGame('network-loss'),
        // the other side's connection went
        event({ game_id: 'opponent-gone', event_type: 'game_started' }),
        event({ game_id: 'opponent-gone', event_type: 'game_aborted', reason_code: 'opponent_left' }),
        // nobody knows
        event({ game_id: 'unknown-end', event_type: 'game_started' }),
        event({ game_id: 'unknown-end', event_type: 'game_aborted', reason_code: 'unknown' }),
      ];
      const c = classifyGames(events, { liveProcesses: new Set() });
      const got = Object.fromEntries([...c].map(([id, v]) => [id, `${v.klass}:${v.reason}`]));
      assert.deepStrictEqual(got, {
        'clean-leave': 'V:explicit_leave',
        'leave-after-drop': 'U:leave_after_fault',
        'leave-after-error': 'U:leave_after_fault',
        'network-loss': 'F:aborted_recovery_expired',
        'opponent-gone': 'U:opponent_gone',
        'unknown-end': 'U:aborted_unknown',
      }, `endings were mixed up: ${JSON.stringify(got)}`);
      notes.push('temiz açık ayrılma V; kopma veya sunucu hatasından SONRA ayrılma V değil U; '
        + 'ağ kopması + süre aşımı F; rakibin kopması ve nedeni bilinmeyen kapanış U — birbirine karışmadı');
    }

    // --- 4. reconciliation finds each planted defect -----------------------
    {
      // Each game below carries exactly one problem, so a finding cannot be
      // credited to the wrong cause.
      const events = [
        ...completeGame('rec-ok', { persist: true }),
        ...completeGame('rec-score', { persist: true }),
        ...completeGame('rec-missing-row', { persist: true }),
        ...completeGame('rec-unexpected-row'), // decision says skip
      ];
      // A final score that does not follow from the rounds.
      const bad = events.find((e) => e.game_id === 'rec-score' && e.event_type === 'game_finished');
      bad.details = { ...bad.details, score_a: 7 };

      const matchRows = [
        { id: 1, match_uid: 'rec-ok', player_a: 10, player_b: 20, score_a: 3, score_b: 1, winner_id: 10 },
        { id: 2, match_uid: 'rec-score', player_a: 10, player_b: 20, score_a: 3, score_b: 1, winner_id: 10 },
        // rec-missing-row: expected, absent.
        { id: 3, match_uid: 'rec-unexpected-row', player_a: 10, player_b: 20, score_a: 3, score_b: 1, winner_id: 10 },
        { id: 4, match_uid: 'ghost-game', player_a: 10, player_b: 20, score_a: 1, score_b: 0, winner_id: 10 },
      ];
      const { findings } = reconcile({ events, matchRows });
      const kinds = new Map(findings.map((f) => [`${f.gameId}:${f.kind}`, f.detail]));
      assert.ok(kinds.has('rec-score:score_mismatch'), `score mismatch not found: ${JSON.stringify(findings)}`);
      assert.ok(kinds.has('rec-missing-row:row_missing'), 'a missing expected row was not reported');
      assert.ok(kinds.has('rec-unexpected-row:unexpected_row'),
        'a row that policy forbade was not reported');
      assert.ok(kinds.has('ghost-game:row_without_events'),
        'a stored result with no events behind it was assumed fine');
      // And the clean game produces nothing.
      assert.ok(![...kinds.keys()].some((k) => k.startsWith('rec-ok:')),
        `the clean game was flagged: ${JSON.stringify(findings)}`);
      notes.push('uzlaştırma dört ekilmiş kusuru da buldu (skor uyuşmazlığı, beklenen satır yok, '
        + 'politikaya aykırı satır, olayı olmayan satır) ve temiz maçı işaretlemedi');
    }

    // --- 5. one id, two different results ---------------------------------
    {
      const events = [...completeGame('dup-1', { persist: true })];
      events.push(event({
        game_id: 'dup-1',
        event_type: 'game_finished',
        details: { score_a: 9, score_b: 0, rounds_played: 2, winner_seat: 'A' },
      }));
      const { findings } = reconcile({ events, matchRows: [] });
      assert.ok(findings.some((f) => f.kind === 'conflicting_results'),
        `two different results under one id were not reported: ${JSON.stringify(findings)}`);
      notes.push('tek maç kimliği altında iki farklı sonuç: DB\'de tek satır kalsa bile '
        + 'çelişki raporlandı');
    }

    // --- 6. the commands, as a reader runs them ---------------------------
    {
      await client.query('TRUNCATE telemetry_events');
      await insert(client, [
        ...completeGame('cli-1'),
        ...completeGame('cli-2'),
        ...leftGame('cli-3'),
        // Automated traffic, which must NOT be counted as a human beta game.
        ...completeGame('cli-robot').map((row) => ({ ...row, traffic_kind: 'automated' })),
      ]);

      const json = await run(REPORT, ['--from', '2026-10-01T00:00:00Z', '--to', '2026-10-09T00:00:00Z',
        '--cohort', 'beta-01', '--format', 'json', '--min-games', '3'],
      { REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '' });
      const report = JSON.parse(json.stdout);
      assert.strictEqual(report.summary.H, 3,
        `automated traffic leaked into H (${report.summary.H}): ${JSON.stringify(report.summary.counts)}`);
      assert.deepStrictEqual(report.summary.counts, { C: 2, V: 1, P: 0, F: 0, U: 0 });
      assert.strictEqual(report.summary.technicalCompletionPct, 100);
      assert.strictEqual(report.summary.totalCompletionPct, 66.67);
      assert.strictEqual(report.status, 'PASS', `status was ${report.status}: ${report.notes}`);
      assert.strictEqual(json.code, 0, `a PASS report exited ${json.code}`);
      assert.ok(report.scope.asOf, 'the report does not say when it was computed');
      assert.ok(report.limits.length >= 3, 'the report does not state what it cannot prove');

      const md = await run(REPORT, ['--from', '2026-10-01T00:00:00Z', '--to', '2026-10-09T00:00:00Z',
        '--cohort', 'beta-01', '--min-games', '1000'],
      { REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '' });
      assert.ok(md.stdout.includes('INSUFFICIENT_DATA'),
        'a window with too few games did not say so');
      // Anything but PASS must be visible to a scheduler, not just to a reader.
      assert.notStrictEqual(md.code, 0, 'a report that is not a PASS exited 0');
      assert.ok(md.stdout.includes('(2/3)'), 'the markdown report hides the raw counts');

      // No connection string anywhere: the script must refuse rather than
      // silently reporting on nothing.
      const noUrl = await run(REPORT, ['--format', 'json'],
        { REPORT_DATABASE_URL: '', DATABASE_URL: '' });
      assert.strictEqual(noUrl.code, 2, 'the report ran without a database');
      assert.ok(/REPORT_DATABASE_URL/.test(noUrl.stderr), noUrl.stderr);

      const integrity = await run(INTEGRITY, ['--cohort', 'beta-01', '--format', 'json'],
        { REPORT_DATABASE_URL: databaseUrl, DATABASE_URL: '' });
      const found = JSON.parse(integrity.stdout);
      assert.strictEqual(found.checked, 4, `reconciliation looked at ${found.checked} games`);
      assert.strictEqual(found.findings.length, 0,
        `clean data produced findings: ${JSON.stringify(found.findings)}`);
      assert.strictEqual(integrity.code, 0);
      notes.push('komutlar gerçekten koştu: rapor JSON/Markdown üretti (H=3, otomatik trafik '
        + 'sayılmadı, teknik %100, toplam %66.67, ham sayılar yazılı), az maçta INSUFFICIENT_DATA, '
        + 'bağlantı adresi olmadan çalışmayı reddetti (adres komut satırında değil, ortamda), '
        + 'uzlaştırma temiz veride bulgu üretmedi');
    }
  } finally {
    await client.end().catch(() => {});
  }

  return notes.join(' · ');
};

module.exports.needsDatabase = true;
