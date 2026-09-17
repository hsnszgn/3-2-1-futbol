// A small in-memory rate limiter.
//
// No dependency and no Redis: this server runs as a single instance, so a Map
// is the whole story. If it is ever scaled to more than one instance each will
// keep its own count, which is fine here — the point is to stop one person
// hammering an endpoint, not to enforce an exact quota.

const buckets = new Map();

/**
 * @param {string} name     Which limit this is (so two limits can share a key).
 * @param {number} max      Allowed hits per window.
 * @param {number} windowMs Length of the window.
 */
function createLimiter(name, max, windowMs) {
  // Hits still inside the window, with the expired ones dropped.
  function live(id) {
    const now = Date.now();
    const hits = (buckets.get(id) || []).filter((t) => now - t < windowMs);
    buckets.set(id, hits);
    return hits;
  }

  const verdict = (hits) => (hits.length >= max
    ? { ok: false, retryAfterMs: windowMs - (Date.now() - hits[0]) }
    : { ok: true, retryAfterMs: 0 });

  /** Is this key allowed right now? Does not count against the limit. */
  function check(key) {
    return verdict(live(`${name}:${key}`));
  }

  /** Count one hit against the key and say whether it was allowed. */
  function take(key) {
    const id = `${name}:${key}`;
    const hits = live(id);
    const answer = verdict(hits);
    if (answer.ok) hits.push(Date.now());
    return answer;
  }

  // Express middleware form, keyed by client IP.
  function middleware(req, res, next) {
    const { ok, retryAfterMs } = take(req.ip || 'unknown');
    if (ok) return next();
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({ reason: 'rate_limited', retryAfterMs });
  }

  middleware.take = take;
  middleware.check = check;
  return middleware;
}

// Windows are short, so entries go stale quickly; sweeping keeps a flood of
// distinct IPs from growing the map without bound.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, hits] of buckets) {
    // An hour is longer than any window used here.
    if (!hits.length || now - hits[hits.length - 1] > 60 * 60 * 1000) buckets.delete(id);
  }
}, 10 * 60 * 1000);
sweep.unref();

module.exports = { createLimiter };
