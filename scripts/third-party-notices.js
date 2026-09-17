#!/usr/bin/env node
/**
 * Regenerates THIRD_PARTY_NOTICES.md from the installed dependency tree.
 *
 * Attribution is a licence obligation, not a nicety: MIT, ISC and BSD all
 * require the copyright notice to travel with the software. Generating the
 * file means it can never drift from what is actually installed.
 *
 * Run with: npm run notices
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');

// Licences that would restrict shipping this as a closed-source product.
const COPYLEFT = /\b(GPL|AGPL|SSPL|CDDL|EPL|MPL|CC-BY-NC|Commons Clause)\b/i;
const PERMISSIVE_COPYLEFT = /\bLGPL\b/i;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function licenceOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]) return pkg.licenses[0].type;
  return 'UNKNOWN';
}

/** The licence text itself, when the package ships one. */
function licenceText(dir) {
  const names = fs.readdirSync(dir).filter((f) => /^(LICEN[CS]E|COPYING)/i.test(f));
  if (!names.length) return '';
  try {
    return fs.readFileSync(path.join(dir, names[0]), 'utf8').trim();
  } catch (err) {
    return '';
  }
}

function collect(dir, found = new Map()) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    return found;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (entry.startsWith('@')) {
      collect(full, found);
      continue;
    }
    const pkg = readJson(path.join(full, 'package.json'));
    if (pkg && pkg.name && !found.has(pkg.name)) {
      found.set(pkg.name, {
        name: pkg.name,
        version: pkg.version || '',
        licence: licenceOf(pkg),
        homepage: pkg.homepage || (pkg.repository && (pkg.repository.url || pkg.repository)) || '',
        text: licenceText(full),
      });
    }
    const nested = path.join(full, 'node_modules');
    if (fs.existsSync(nested)) collect(nested, found);
  }
  return found;
}

const packages = [...collect(path.join(ROOT, 'node_modules')).values()]
  .sort((a, b) => a.name.localeCompare(b.name));

const risky = packages.filter((p) => COPYLEFT.test(p.licence) && !PERMISSIVE_COPYLEFT.test(p.licence));
const unknown = packages.filter((p) => p.licence === 'UNKNOWN');

const byLicence = packages.reduce((acc, p) => {
  (acc[p.licence] = acc[p.licence] || []).push(p);
  return acc;
}, {});

const lines = [
  '# Üçüncü Taraf Bildirimleri',
  '',
  'Bu dosya `npm run notices` ile üretilir — elle düzenleme.',
  '',
  `Son üretim: ${new Date().toISOString().slice(0, 10)} · ${packages.length} paket`,
  '',
  '## Kod dışı kaynaklar',
  '',
  '### Wikidata',
  'Futbolcu ve kulüp verisi [Wikidata](https://www.wikidata.org) üzerinden alınır.',
  'Wikidata yapısal verisi **CC0 1.0 Universal** (kamu malı) ile yayımlanır;',
  'ticari kullanım serbesttir ve atıf zorunlu değildir. Buna rağmen NOTICE',
  'dosyasında kaynak belirtilmektedir. Wikidata Query Service kullanımı',
  '[kullanım politikasına](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual)',
  'tabidir: tanımlayıcı bir User-Agent gönderilir ve istek hızı sınırlanır.',
  '',
  '### Yazı tipleri',
  'Arayüz yazı tipleri Google Fonts üzerinden gelir ve **SIL Open Font License 1.1**',
  'ile lisanslıdır. OFL ticari kullanıma izin verir ve arayüzde atıf gerektirmez.',
  '',
  '## npm paketleri',
  '',
];

for (const licence of Object.keys(byLicence).sort()) {
  lines.push(`### ${licence} (${byLicence[licence].length})`, '');
  for (const p of byLicence[licence]) {
    lines.push(`- **${p.name}** ${p.version}${p.homepage ? ` — ${String(p.homepage).replace(/^git\+|\.git$/g, '')}` : ''}`);
  }
  lines.push('');
}

// One full licence text per distinct licence is enough to satisfy the notice
// requirement without a 20,000-line file.
lines.push('## Lisans metinleri', '');
const shown = new Set();
for (const p of packages) {
  if (!p.text || shown.has(p.licence)) continue;
  shown.add(p.licence);
  lines.push(`<details><summary>${p.licence} (örnek: ${p.name})</summary>`, '', '```', p.text, '```', '', '</details>', '');
}

fs.writeFileSync(OUT, lines.join('\n'));

console.log(`THIRD_PARTY_NOTICES.md yazıldı — ${packages.length} paket`);
for (const licence of Object.keys(byLicence).sort()) {
  console.log(`  ${licence.padEnd(24)} ${byLicence[licence].length}`);
}
if (risky.length) {
  console.error('\nDİKKAT — kapalı kaynak dağıtım için riskli lisanslar:');
  risky.forEach((p) => console.error(`  ${p.name} (${p.licence})`));
  process.exitCode = 1;
}
if (unknown.length) {
  console.error('\nDİKKAT — lisansı belirsiz paketler:');
  unknown.forEach((p) => console.error(`  ${p.name}`));
  process.exitCode = 1;
}
if (!risky.length && !unknown.length) console.log('\nTicari kullanım için riskli lisans yok.');
