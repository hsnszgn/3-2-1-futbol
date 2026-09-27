/**
 * The manual staging watcher workflow stays manual, and stays on staging.
 *
 * Adding `schedule:` would start spending runner minutes and sending alerts on
 * its own; where and how often the watcher runs is an open decision
 * (docs/STAGING.md). And the only secrets it may read are the STAGING_ ones: a
 * workflow that picked up a production URL would point the watcher — which
 * writes alert-state rows — at the live database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.github', 'workflows', 'staging-watch.yml');

module.exports = async function run() {
  const text = fs.readFileSync(FILE, 'utf8');
  // Comments are ignored: the header explains the missing schedule by name.
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#'));
  const body = code.join('\n');

  assert.ok(!code.some((l) => /^\s*schedule\s*:/.test(l)), 'the staging watcher gained a schedule');
  for (const trigger of ['push', 'pull_request', 'workflow_run', 'repository_dispatch']) {
    assert.ok(!code.some((l) => new RegExp(`^\\s*${trigger}\\s*:`).test(l)), `the staging watcher runs on ${trigger}`);
  }
  assert.ok(/^\s*workflow_dispatch\s*:/m.test(body), 'the staging watcher cannot be started by hand');
  assert.ok(/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(body), 'the workflow is not read-only');

  const secrets = [...body.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.ok(secrets.length >= 3, `expected the three staging secrets, saw ${secrets.join(', ')}`);
  const foreign = secrets.filter((s) => !s.startsWith('STAGING_'));
  assert.deepStrictEqual(foreign, [], `the staging watcher reads non-staging secrets: ${foreign.join(', ')}`);
  assert.ok(/TELEMETRY_ENVIRONMENT:\s*staging\s*$/m.test(body), 'the watcher is not pinned to the staging environment');

  return `yalnız elle başlatılır (zamanlama yok), salt-okunur yetki, yalnız ${[...new Set(secrets)].join(', ')} okunur, ortam staging'e sabit`;
};
