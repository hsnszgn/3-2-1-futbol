/**
 * The measurement module's promise to the game: a wrong call never throws.
 *
 * Runs WITHOUT a database, so it is part of every run. M2 wired these calls
 * into the scoring path, the finish, the recovery handler and the shutdown, so
 * an exception here is an exception in the middle of a round.
 *
 * Found by review, reproduced before the fix, all three in the production
 * module:
 *   record('game_started', null)          -> TypeError from destructuring null
 *   record('round_scored', {details:null}) -> "Cannot read properties of null"
 *   record('toString', {})                 -> "allowed is not iterable": the
 *     event table is a plain object, so an INHERITED key passed the "is this an
 *     event" check.
 * and recordDurable() rejected instead of resolving false.
 *
 * The fix is explicit validation, not a catch that swallows everything: each
 * case below is refused for a stated reason and counted.
 */
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const PROBE = path.join(__dirname, 'fixtures', 'telemetry-probe.js');

function probe(scenario, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, scenario], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('__PROBE__'));
      if (!line || code !== 0) {
        reject(new Error(`${scenario}: probe exited ${code}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('__PROBE__'.length)));
    });
  });
}

module.exports = async function run() {
  // No database on purpose: nothing may be written, and nothing may depend on it.
  const result = await probe('bad-input', { DATABASE_URL: '', TELEMETRY_ENABLED: '1' });

  const threw = result.results.filter((r) => r.threw !== null);
  assert.deepStrictEqual(threw, [], `record() threw into the caller:\n${JSON.stringify(threw, null, 1)}`);

  // Two of these are VALID once null is read as "nothing": no fields at all,
  // and no details. Everything else is a refusal.
  const expectAccepted = new Set(['null fields', 'null details']);
  for (const r of result.results) {
    assert.strictEqual(r.accepted, expectAccepted.has(r.label),
      `${r.label}: accepted=${r.accepted}, expected ${expectAccepted.has(r.label)}`);
  }

  const rejected = result.durable.filter((d) => d.rejected);
  assert.deepStrictEqual(rejected, [], `recordDurable() rejected instead of resolving false: ${JSON.stringify(rejected)}`);
  for (const d of result.durable) {
    assert.strictEqual(d.value, false, `recordDurable(${d.label}) resolved ${d.value}`);
  }

  const refusals = result.results.length - expectAccepted.size;
  // Two of the three recordDurable calls are invalid input; the third
  // ("null details") is valid but has nowhere to go, which is not a refusal.
  assert.strictEqual(result.health.invalid, refusals + 2,
    `refusals were not all counted: ${result.health.invalid} of ${refusals + 2}`);
  assert.strictEqual(result.health.degraded, 'invalid_event',
    'refused input did not mark the measurement as suspect');

  // Switched off (the default): a valid event is a quiet no-op — nothing queued,
  // nothing counted as lost, nothing degraded — and a wrong call is STILL refused,
  // so development and tests keep catching bad calls.
  const off = await probe('disabled', { DATABASE_URL: '', TELEMETRY_ENABLED: '' });
  assert.strictEqual(off.health.enabled, false);
  assert.strictEqual(off.valid, null, 'a valid event was accepted with measurement switched off');
  assert.strictEqual(off.durable, false);
  assert.strictEqual(off.health.queued, 0, 'events are held in memory while measurement is off');
  assert.strictEqual(off.health.dropped, 1, `only the invalid call should count: ${off.health.dropped}`);
  assert.strictEqual(off.health.invalid, 1);

  return `kapalıyken (varsayılan) geçerli olay ne kuyruğa ne tabloya girdi, arıza sayılmadı; `
    + `geçersiz çağrı yine reddedildi · `
    + `${result.results.length} bozuk/sınır girdiden hiçbiri çağırana fırlatmadı `
    + `(${refusals} reddedildi, null alan/detay "boş" olarak kabul), `
    + `recordDurable 3 vakada da reddetmek yerine false döndü, ${result.health.invalid} ret sayıldı, `
    + 'süreç "invalid_event" olarak işaretlendi — prototipten gelen toString/constructor/__proto__ '
    + 'olay türü sayılmadı';
};
