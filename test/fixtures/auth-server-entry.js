/**
 * The real server with a controllable account service.
 *
 * Some things can only be tested by making the identity lookup misbehave on
 * demand: a query that takes seconds, or one that fails outright. No real
 * database can be asked for that at a chosen moment, so the account boundary is
 * replaced here — everything else, including the whole socket and HTTP surface,
 * is the production code path.
 *
 * Controlled from the parent over IPC:
 *   { type: 'setLookupMode', mode: 'normal' | 'delay' | 'error' }
 * and it reports back { type: 'lookupPending' } when a controlled lookup starts,
 * and { type: 'recordMatchCalled', data } whenever a result would be saved —
 * which is how a test can see a match being recorded against a revoked account
 * without needing a database at all.
 */
const path = require('path');

const db = require(path.join(__dirname, '..', '..', 'server', 'db'));
const accounts = require(path.join(__dirname, '..', '..', 'server', 'accounts'));

const SESSIONS = new Map([
  ['token-ada', { id: 101, username: 'ada', display_name: 'Ada' }],
  ['token-bora', { id: 202, username: 'bora', display_name: 'Bora' }],
  // A second, independent session for the SAME account as token-ada. Signing
  // out of one must not sign out of the other.
  ['token-ada-2', { id: 101, username: 'ada', display_name: 'Ada' }],
]);

const LOOKUP_DELAY_MS = Number(process.env.AUTH_LOOKUP_DELAY_MS) || 3000;
let mode = 'normal';

db.isEnabled = () => true;
db.migrate = async () => true;
accounts.purgeExpiredSessions = async () => 0;

accounts.playerForToken = async (token) => {
  if (mode !== 'normal') {
    if (process.send) process.send({ type: 'lookupPending', mode, token: String(token) });
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));
    if (mode === 'error') throw new Error('controlled account lookup failure');
  }
  return SESSIONS.get(String(token)) || null;
};

accounts.endSession = async (token) => { SESSIONS.delete(String(token)); };
accounts.endAllSessions = async (playerId) => {
  for (const [token, player] of [...SESSIONS]) {
    if (player.id === playerId) SESSIONS.delete(token);
  }
  return 0;
};
accounts.recordMatch = async (data) => {
  if (process.send) process.send({ type: 'recordMatchCalled', data });
  return true;
};
accounts.profileById = async () => null;
accounts.profile = async () => null;
accounts.headToHead = async () => ({ games: 0 });
accounts.leaderboard = async () => [];

process.on('message', (msg) => {
  if (msg && msg.type === 'setLookupMode') {
    mode = msg.mode;
    if (process.send) process.send({ type: 'modeSet', mode });
  }
});

require(path.join(__dirname, 'server-entry.js'));
