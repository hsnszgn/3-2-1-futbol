/**
 * The database TLS policy, and nothing else.
 *
 * Its own module so that anything that needs to CONNECT — the server's pool,
 * and the read-only report commands — can use one policy without loading
 * server/db.js. Requiring db.js opens a connection pool as a side effect, which
 * a command-line report must not do; so the report commands had been written
 * with their own copy of the old rule instead (a regex over the whole URL, and
 * no removal of sslmode). Review found both old holes back open in them: a
 * password containing "localhost" turned TLS off for a remote host, and
 * ?sslmode=no-verify switched verification off. One module, no side effects,
 * used by every connection.
 */

const fs = require('fs');
const net = require('net');
// The driver's own final parse of a connection string — the same code pg runs
// when it connects. Used below to CHECK the TLS decision against what will
// actually happen, rather than trusting a hand-written reading of the URL.
const DriverParameters = require('pg/lib/connection-parameters');

// Hosts that are this machine. Only these skip TLS, and only by PARSED
// hostname: the previous test was a regex over the whole connection string, so
// a password containing "localhost", or any parameter mentioning 127.0.0.1,
// silently turned encryption off for a remote database.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// SSL settings that `pg-connection-string` reads out of the URL. They do not
// merely coexist with the `ssl` option — they REPLACE it: measured with
// pg's own ConnectionParameters, `?sslmode=no-verify` turns an explicit
// { rejectUnauthorized: true } into { rejectUnauthorized: false }, and
// `?sslmode=disable` turns it into false. So a connection string handed to us
// can undo verification from the outside. They are removed from the URL and the
// decision is made here, in one place, instead.
const SSL_URL_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'];

function readCa() {
  const inline = process.env.DB_CA_CERT;
  if (inline) return inline;
  const file = process.env.DB_CA_CERT_PATH;
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Loud, and not a silent downgrade: a CA that was meant to be used and
    // cannot be read must not turn into "verify against the system store".
    throw new Error(`DB_CA_CERT_PATH could not be read (${file}): ${err.message}`);
  }
}

/**
 * Works out how to connect, and how to verify the server while doing it.
 *
 * Exported for the tests: the interesting cases are a connection string that
 * tries to weaken TLS and a host that only LOOKS local, and neither can be
 * driven through a live database.
 *
 * @returns {{connectionString: string, ssl: object|false, host: string,
 *            local: boolean, ignoredParams: string[], verified: boolean}}
 */
function sslConfigFor(raw, env = process.env) {
  const config = decideTls(raw, env);
  // The acceptance rule, in one place: whatever this function decided, the
  // driver — reading the exact string and ssl object it will be handed — must
  // arrive at the same host and the same TLS setting. Three times a
  // hand-written reading of the URL disagreed with pg (a host parameter over
  // the authority, a repeated host, an empty last host), and each time the
  // disagreement was "policy says local, no TLS; driver dials a remote server
  // in plaintext". Patching each new spelling would go on forever. Checking the
  // outcome does not.
  assertDriverAgrees(config);
  return config;
}

/**
 * Throws unless pg, given exactly this string and ssl object, would connect to
 * the host the TLS decision was made for, with that TLS setting.
 *
 * Separate so it can be tested on its own: the explicit rule above refuses
 * every ambiguous spelling known today before this ever runs, so without a
 * direct test this layer would be unproven — and it is the one that still holds
 * for a spelling nobody has thought of yet.
 */
function assertDriverAgrees(config) {
  const actual = new DriverParameters({ connectionString: config.connectionString, ssl: config.ssl });
  const driverHost = String(actual.host || '').toLowerCase();
  if (driverHost !== config.host) {
    throw new Error(`DATABASE_URL is ambiguous: TLS was decided for "${config.host}" `
      + `but the driver would connect to "${driverHost}"; refusing to connect`);
  }
  const driverVerifies = Boolean(actual.ssl) && actual.ssl.rejectUnauthorized === true;
  if (config.verified !== driverVerifies || (!config.ssl && actual.ssl)) {
    throw new Error('DATABASE_URL is ambiguous: the driver would not apply the TLS setting '
      + 'that was decided for it; refusing to connect');
  }
}

function decideTls(raw, env) {
  let url = null;
  try {
    url = new URL(raw);
  } catch (err) {
    url = null;
  }
  if (!url) {
    // Previously "treat it as remote". But an address this code cannot read is
    // exactly one whose target it cannot check, and the check below is the
    // whole point.
    throw new Error('DATABASE_URL could not be parsed; refusing to guess its target');
  }

  const urlHost = url.hostname.toLowerCase();

  // Where pg will ACTUALLY connect. A `host=` query parameter overrides the
  // authority in the URL — measured against the driver's own parser — so reading
  // URL.hostname alone let a connection string keep the local no-TLS exception
  // while pointing the driver at a remote server:
  //
  //   postgres://user:pw@localhost/app?host=db.example.com
  //     policy said host=localhost, local=true, ssl=false
  //     driver connected to db.example.com, unencrypted
  //
  // The decision follows the real target, which is the safe direction: a remote
  // target is verified even when the authority looks local.
  // A repeated `host` parameter is where hand-reading the URL went wrong: this
  // code took the FIRST value while `pg-connection-string` takes the last, so
  // `?host=localhost&host=db.example.com` had the policy deciding for localhost
  // (no TLS) while the driver dialled db.example.com — and reversing the order
  // moved the divergence to the other side. Rather than reproduce the driver's
  // precedence from memory, a connection string whose target is ambiguous is
  // REFUSED: there is one right answer only when there is one host.
  //
  // The accepted forms, stated rather than implied: the host in the authority,
  // optionally replaced by ONE non-empty `host` parameter. Anything else is
  // refused. The previous version dropped empty values before counting them
  // (`filter(Boolean)`), and that changed the meaning: for
  // `?host=localhost&host=` the policy saw one host, "localhost", while the
  // driver took the empty last value, fell back to the authority and dialled
  // the remote server with TLS off.
  const rawHosts = url.searchParams.getAll('host');
  if (rawHosts.length > 1) {
    throw new Error(`DATABASE_URL has ${rawHosts.length} "host" parameters; `
      + 'refusing to guess which one TLS applies to');
  }
  if (rawHosts.length === 1 && rawHosts[0].trim() === '') {
    throw new Error('DATABASE_URL has an empty "host" parameter; refusing to guess its target');
  }
  const queryHost = rawHosts.length === 1 ? rawHosts[0].trim().toLowerCase() : '';
  if (!queryHost && !urlHost) {
    // pg would fall back to PGHOST or "localhost" — a target nobody wrote down.
    throw new Error('DATABASE_URL names no host; refusing to guess its target');
  }
  const host = queryHost || urlHost;
  const local = Boolean(host) && LOCAL_HOSTS.has(host);

  const hostOverridden = Boolean(queryHost) && queryHost !== urlHost;
  const ignoredParams = [];
  for (const param of SSL_URL_PARAMS) {
    if (!url.searchParams.has(param)) continue;
    ignoredParams.push(param);
    url.searchParams.delete(param);
  }
  const connectionString = url.toString();

  // DB_SSL: 'off' disables TLS outright (a local socket, or a provider-side
  // tunnel that terminates it), 'on' forces verification even for a local host.
  // There is no "encrypt but do not check" setting: that is what the old
  // rejectUnauthorized: false was, and it accepts any certificate at all,
  // including one a man in the middle just generated.
  const mode = String(env.DB_SSL || '').toLowerCase();
  if (mode === 'off') {
    return { connectionString, ssl: false, host, urlHost, hostOverridden, local, ignoredParams, verified: false };
  }
  // The transition escape hatch, and the only way back to the old behaviour:
  // encrypted but accepting any certificate. It has to be set deliberately, it
  // is logged on every boot, and it exists because turning verification on for
  // a provider whose chain has not been confirmed would take accounts down —
  // not because "it is fine in production".
  if (mode === 'no-verify') {
    return {
      connectionString,
      ssl: { rejectUnauthorized: false },
      host,
      urlHost,
      hostOverridden,
      local,
      ignoredParams,
      verified: false,
    };
  }
  if (local && mode !== 'on') {
    return { connectionString, ssl: false, host, urlHost, hostOverridden, local, ignoredParams, verified: false };
  }

  const ca = readCa();
  return {
    connectionString,
    ssl: {
      rejectUnauthorized: true,
      // Checked against the name we are actually asking for, so a valid
      // certificate for some OTHER host is still refused. An IP address is not
      // a valid SNI name (RFC 6066) — Node verifies it against the address
      // instead, so it is left unset there.
      // URL.hostname keeps the brackets on an IPv6 literal ("[2001:db8::1]"),
      // which net.isIP() does not recognise — so a bracketed address used to be
      // sent as an SNI name. That failed closed (the name never matches), but it
      // was still wrong.
      ...(host && net.isIP(host.replace(/^\[|\]$/g, '')) === 0 ? { servername: host } : {}),
      ...(ca ? { ca } : {}),
    },
    host,
    urlHost,
    hostOverridden,
    local,
    ignoredParams,
    verified: true,
  };
}


module.exports = { sslConfigFor, assertDriverAgrees, LOCAL_HOSTS, SSL_URL_PARAMS };
