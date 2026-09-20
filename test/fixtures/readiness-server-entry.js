/**
 * The real server with the account service's READINESS under test control.
 *
 * `db.isReady()` is the one thing the client cannot make change on demand: it
 * becomes true when the migration succeeds and, by design, stays true. To drive
 * the "configured but not ready yet" state — a migration still running, a
 * database that is not accepting connections at deploy time — the gate in front
 * of it is opened from the parent over IPC:
 *
 *   { type: 'setReady', open: true }   ->  acknowledged as { type: 'readySet' }
 *
 * Everything else, including the real PostgreSQL connection behind it, is the
 * production code path: with the gate open, accounts genuinely work.
 */
const path = require('path');

const db = require(path.join(__dirname, '..', '..', 'server', 'db'));

const realIsReady = db.isReady;
let gateOpen = process.env.READY_GATE === 'open';

// Closed gate means exactly what a failed migration means: configured
// (isEnabled stays true) but not usable.
db.isReady = () => gateOpen && realIsReady();

process.on('message', (msg) => {
  if (msg && msg.type === 'setReady') {
    gateOpen = Boolean(msg.open);
    if (process.send) process.send({ type: 'readySet', open: gateOpen, migrated: realIsReady() });
  }
});

require(path.join(__dirname, 'server-entry.js'));
