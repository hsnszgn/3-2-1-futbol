/**
 * The CI workflow file itself.
 *
 * Why this exists: a comment written INSIDE a YAML block scalar (`options: >-`)
 * is not a comment. It is text, and GitHub passed it straight to
 * `docker create` as arguments. The postgres container never started, both jobs
 * failed at "Initialize containers" before checking out any code, and two
 * commits (877d3fc, 80cd09c) went red. A YAML parser was run on the file at the
 * time and said it was fine — because it is valid YAML. The meaning was wrong,
 * not the syntax.
 *
 * Dependency-free on purpose: the project has no YAML library, and the check
 * needed is narrow enough to do on the text.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.github', 'workflows', 'ci.yml');

/**
 * Every block scalar in the file, as { key, line, body[] }.
 * A block scalar starts at `key: >`, `key: >-`, `key: |`, `key: |-` and runs for
 * every following line that is blank or indented deeper than the key.
 */
function blockScalars(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*)([\w.-]+):\s*[>|][-+]?\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { body.push({ n: j + 1, text: line }); continue; }
      const lead = line.match(/^(\s*)/)[1].length;
      if (lead <= indent) break;
      body.push({ n: j + 1, text: line });
    }
    blocks.push({ key: match[2], line: i + 1, body });
  }
  return blocks;
}

module.exports = async function run() {
  const text = fs.readFileSync(FILE, 'utf8');
  const blocks = blockScalars(text);
  assert.ok(blocks.length > 0, 'found no block scalars at all — the scanner is not reading this file');

  // Control: the scanner must catch the exact text that broke CI. Without this
  // a scanner that finds nothing would pass forever.
  const broken = [
    '        options: >-',
    '          # -U postgres on purpose',
    '          --health-cmd "pg_isready -U postgres"',
  ].join('\n');
  const control = blockScalars(broken);
  assert.ok(control[0] && control[0].body.some((l) => l.text.trim().startsWith('#')),
    'the scanner does not see a # line inside a block scalar, so it proves nothing');

  const offenders = [];
  for (const block of blocks) {
    for (const line of block.body) {
      if (line.text.trim().startsWith('#')) {
        offenders.push(`line ${line.n} (inside "${block.key}:" from line ${block.line}): ${line.text.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    `a "#" line inside a block scalar is TEXT, not a comment:\n${offenders.join('\n')}`);

  // The service options specifically: after folding they are docker arguments
  // and must be nothing but flags.
  const options = blocks.find((b) => b.key === 'options');
  assert.ok(options, 'the postgres service has no options block');
  const folded = options.body.map((l) => l.text.trim()).filter(Boolean).join(' ');
  assert.ok(folded.startsWith('--'), `docker options do not start with a flag: ${folded.slice(0, 60)}`);
  assert.ok(/--health-cmd "pg_isready -U postgres"/.test(folded),
    `the health check does not name the postgres user: ${folded}`);

  const runs = blocks.filter((b) => b.key === 'run').length;
  return `${blocks.length} blok skaler tarandı (${runs} run), hiçbirinin içinde "#" satırı yok; `
    + 'kontrol: 877d3fc\'yi kıran metin tarayıcı tarafından yakalanıyor; '
    + `docker seçenekleri yalnız bayrak: ${folded}`;
};
