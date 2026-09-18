/**
 * Boots the real server with Wikidata replaced by a deterministic stand-in.
 *
 * The tests are about the server's own behaviour — payload handling, round
 * timing, room bookkeeping — so the football lookup is mocked to keep them
 * fast and offline. Everything else is the production code path.
 */
// A deploy-time squad snapshot may exist on the developer's machine. It is
// gitignored, so its presence differs between checkouts — and squadStore
// answers from it before the mock below is ever consulted. Pointing the path
// at a file that cannot exist makes the fixture the only source of truth.
process.env.SQUAD_SNAPSHOT_PATH = require('path').join(__dirname, 'no-snapshot-on-purpose.json');

const realFetch = global.fetch;

const CLUBS = {
  chelsea: 'Q_CHELSEA',
  liverpool: 'Q_LIVERPOOL',
  arsenal: 'Q_ARSENAL',
  'manchester united': 'Q_MANUTD',
  napoli: 'Q_NAPOLI',
};

// One player who spans Chelsea and Liverpool, so a round is always winnable.
const PLAYERS = [
  { qid: 'Q_SALAH', name: 'Mohamed Salah', clubs: ['Q_CHELSEA', 'Q_LIVERPOOL'] },
  { qid: 'Q_TORRES', name: 'Fernando Torres', clubs: ['Q_CHELSEA', 'Q_LIVERPOOL'] },
  { qid: 'Q_LUKAKU', name: 'Romelu Lukaku', clubs: ['Q_MANUTD', 'Q_CHELSEA', 'Q_NAPOLI'] },
];

/** Tests can slow the lookup down to exercise timing paths. */
const LOOKUP_DELAY_MS = Number(process.env.TEST_LOOKUP_DELAY_MS || 20);

global.fetch = async (url) => {
  const str = String(url);
  await new Promise((r) => setTimeout(r, LOOKUP_DELAY_MS));

  if (str.includes('wbsearchentities')) {
    const term = decodeURIComponent((str.match(/search=([^&]+)/) || [, ''])[1]).toLowerCase();
    const qid = CLUBS[term];
    return {
      ok: true,
      json: async () => ({
        search: qid ? [{ id: qid, label: term, description: 'association football club' }] : [],
      }),
    };
  }

  if (str.includes('sparql')) {
    const q = decodeURIComponent(str);
    const block = (name) => {
      // Character classes instead of backslash escapes: the escaping was wrong
      // here once (the regex looked for an optional literal backslash rather
      // than a "?"), the block never matched, and the mock silently returned
      // empty squads. Character classes cannot be mis-escaped.
      const m = q.match(new RegExp('VALUES [?]' + name + ' [{]([^}]*)[}]'));
      return m ? [...m[1].matchAll(/wd:(\S+)/g)].map((x) => x[1]) : [];
    };

    const wantedPlayers = block('player');
    if (wantedPlayers.length) {
      return {
        ok: true,
        json: async () => ({
          results: {
            bindings: PLAYERS.filter((p) => wantedPlayers.includes(p.qid)).map((p) => ({
              player: { value: `http://www.wikidata.org/entity/${p.qid}` },
              playerLabel: { value: p.name },
              playerAltLabel: { value: '' },
            })),
          },
        }),
      };
    }

    const teams = block('team');
    return {
      ok: true,
      json: async () => ({
        results: {
          bindings: PLAYERS.filter((p) => p.clubs.some((c) => teams.includes(c)))
            .map((p) => ({ player: { value: `http://www.wikidata.org/entity/${p.qid}` } })),
        },
      }),
    };
  }

  return realFetch(url);
};

// Port allocation: the runner used to hand down a random port, which collided
// often enough that a real spec failed as "server did not come up". Instead the
// runner passes PORT=0, the OS picks a free port, and we report the one we
// actually got back over IPC. No guessing, no collisions.
const http = require('http');
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function patchedListen(...args) {
  this.once('listening', () => {
    const address = this.address();
    if (address && process.send) process.send({ type: 'listening', port: address.port });
  });
  return realListen.apply(this, args);
};

require('../../server/index.js');
