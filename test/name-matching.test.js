/**
 * What counts as naming the right player.
 *
 * This is scoring correctness, not a nicety: a guess that matches wins the
 * round. The bug that prompted this was "de de" scoring against Kevin De
 * Bruyne — the multi-token rule only asked whether every token appeared
 * somewhere in the name, so repeating a particle was enough to take a point
 * off the other player.
 *
 * The risk in fixing it is the opposite mistake: tightening until real answers
 * are refused. So every rule here is pinned from both sides — what must match
 * and what must not.
 */
const assert = require('assert');
const { matchPlayerName } = require('../server/gameLogic');

const SQUAD = [
  { name: 'Kevin De Bruyne' },
  { name: 'Edwin van der Sar' },
  { name: 'Hakan Çalhanoğlu' },
  { name: 'Mohamed Salah', aliases: ['Mo Salah'] },
  { name: 'İlkay Gündoğan' },
  { name: 'Vedat Muriqi' },
  { name: 'Ángel Di María' },
];

const ACCEPT = [
  // Exactly as written, and as typed without the Turkish letters.
  ['Kevin De Bruyne', 'Kevin De Bruyne'],
  ['Hakan Çalhanoğlu', 'Hakan Çalhanoğlu'],
  ['hakan calhanoglu', 'Hakan Çalhanoğlu'],
  ['calhanoglu', 'Hakan Çalhanoğlu'],
  ['ilkay gundogan', 'İlkay Gündoğan'],
  ['gundogan', 'İlkay Gündoğan'],
  ['di maria', 'Ángel Di María'],
  ['angel di maria', 'Ángel Di María'],

  // Surname alone, the most common way to answer under time pressure.
  ['bruyne', 'Kevin De Bruyne'],
  ['muriqi', 'Vedat Muriqi'],
  ['salah', 'Mohamed Salah'],

  // Surname with its particles, in the order people actually write them.
  ['de bruyne', 'Kevin De Bruyne'],
  ['van der sar', 'Edwin van der Sar'],

  // Reversed, which is a normal way to type a name.
  ['salah mohamed', 'Mohamed Salah'],

  // A Wikidata alias.
  ['mo salah', 'Mohamed Salah'],

  // Ordinary typos on a name long enough for one to be unambiguous.
  ['bruyn', 'Kevin De Bruyne'],
  ['calhanoglou', 'Hakan Çalhanoğlu'],
  ['gundogaan', 'İlkay Gündoğan'],

  // Punctuation and spacing people type without thinking.
  ['  Mohamed   Salah  ', 'Mohamed Salah'],
  ['van-der-sar', 'Edwin van der Sar'],
];

const REFUSE = [
  // The bug: a particle, repeated, used to be enough.
  'de de',
  'de de de',
  'van van',
  'di di',

  // Particles on their own identify nobody.
  'de',
  'van',
  'van der',
  'di',

  // Too short to be treated loosely: one edit is most of the word.
  'mur',
  'sar',
  'mo',

  // Someone else entirely, and near-misses that are still someone else.
  'cristiano ronaldo',
  'messi',
  'kevin bruyne sar',

  // Not a name at all.
  '',
  '   ',
  '123',
  '?!',
];

module.exports = async function run() {
  const failures = [];

  for (const [guess, expected] of ACCEPT) {
    const got = matchPlayerName(guess, SQUAD);
    if (got !== expected) failures.push(`kabul edilmeliydi: ${JSON.stringify(guess)} -> ${got} (beklenen ${expected})`);
  }

  for (const guess of REFUSE) {
    const got = matchPlayerName(guess, SQUAD);
    if (got !== null) failures.push(`reddedilmeliydi: ${JSON.stringify(guess)} -> ${got}`);
  }

  assert.deepStrictEqual(failures, [], `\n  ${failures.join('\n  ')}`);

  // The reported case, called out on its own so a regression names itself.
  assert.strictEqual(matchPlayerName('de de', [{ name: 'Kevin De Bruyne' }]), null,
    '"de de" still matches Kevin De Bruyne');

  // A one-player squad must not become a free pass: with nobody else to
  // confuse it with, a meaningless guess is still meaningless.
  assert.strictEqual(matchPlayerName('de', [{ name: 'Kevin De Bruyne' }]), null,
    'a single particle matched in a one-player squad');

  return `${ACCEPT.length} kabul + ${REFUSE.length} ret örneği doğrulandı ("de de" dahil)`;
};
