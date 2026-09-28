/**
 * The runtime that is deployed is the runtime that was tested.
 *
 * The Render service did not use render.yaml: it chose Node 26.10.0 from
 * `engines: ">=22.0.0"` — a version CI never ran — and built with
 * `npm install`. Three places now have to agree, and this checks that they do:
 *   .node-version        the exact version a host picks up from the repository
 *   render.yaml          NODE_VERSION for a Blueprint-managed service
 *   ci.yml               the first matrix entry, the version the deployment pins
 * and `engines` must admit only the majors CI runs (22 and 24).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

module.exports = async function run() {
  const pinned = read('.node-version').trim();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, `.node-version is not an exact version: "${pinned}"`);

  const ci = read('.github/workflows/ci.yml').match(/node:\s*\[\s*'([\d.]+)'\s*,\s*'([\d.]+)'\s*\]/);
  assert.ok(ci, 'the CI matrix was not found');
  assert.strictEqual(pinned, ci[1], `.node-version ${pinned} is not the version CI pins (${ci[1]})`);

  const render = read('render.yaml').match(/key:\s*NODE_VERSION\s*\n\s*value:\s*([\d.]+)/);
  assert.ok(render, 'render.yaml has no NODE_VERSION');
  assert.strictEqual(render[1], pinned, `render.yaml NODE_VERSION ${render[1]} differs from .node-version ${pinned}`);

  const engines = JSON.parse(read('package.json')).engines.node;
  const majors = engines.split('||').map((part) => part.trim());
  assert.deepStrictEqual(majors, ['22.x', '24.x'],
    `engines "${engines}" admits versions CI does not run (Render picked 26.10.0 from ">=22.0.0")`);
  for (const v of [ci[1], ci[2]]) {
    assert.ok(majors.includes(`${v.split('.')[0]}.x`), `engines does not admit the tested ${v}`);
  }
  const lock = JSON.parse(read('package-lock.json'));
  assert.strictEqual(lock.packages[''].engines && lock.packages[''].engines.node, engines,
    'package-lock.json is out of step with package.json engines');
  return `.node-version = render.yaml = CI sabiti (${pinned}); engines "${engines}" yalnız test edilen ana sürümler; kilit dosyası uyumlu`;
};
