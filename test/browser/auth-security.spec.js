/**
 * Session and authentication hardening, over the real HTTP surface.
 *
 * Requires a throwaway database.
 */
const assert = require('assert');

module.exports.needsDatabase = true;
module.exports.run = async ({ baseUrl }) => {
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(baseUrl + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };

  const stamp = Date.now().toString().slice(-6);
  const user = `guv${stamp}`;
  const notes = [];

  // Password length is enforced server-side, not just in the form.
  const weak = await call('/api/register', { method: 'POST', body: { username: `w${stamp}`, password: '12345' } });
  assert.strictEqual(weak.status, 400, 'a 5-character password must be rejected');
  assert.strictEqual(weak.body.reason, 'weak_password');

  const reg = await call('/api/register', { method: 'POST', body: { username: user, password: 'sifre123' } });
  assert.strictEqual(reg.status, 200, `registration failed: ${JSON.stringify(reg.body)}`);
  const token = reg.body.token;

  // The token works in a header and only in a header: URLs leak into logs,
  // history and Referer.
  assert.strictEqual((await call('/api/me', { token })).status, 200, 'header token should work');
  const viaQuery = await fetch(`${baseUrl}/api/me?token=${encodeURIComponent(token)}`);
  assert.strictEqual(viaQuery.status, 401, 'a token in the query string must not be accepted');
  notes.push('jeton sadece başlıkta kabul ediliyor');

  // Signing out ends the session on the server, not just in the browser.
  assert.strictEqual((await call('/api/logout', { method: 'POST', token })).status, 200);
  assert.strictEqual((await call('/api/me', { token })).status, 401,
    'the token must be dead after signing out');
  notes.push('çıkış sunucudaki oturumu da bitiriyor');

  // Repeated wrong passwords lock that account, and only that account.
  const login = await call('/api/login', { method: 'POST', body: { username: user, password: 'sifre123' } });
  assert.strictEqual(login.status, 200);

  let lockedAt = null;
  for (let i = 1; i <= 12 && !lockedAt; i += 1) {
    const attempt = await call('/api/login', { method: 'POST', body: { username: user, password: 'yanlis999' } });
    if (attempt.status === 429) lockedAt = i;
    else assert.strictEqual(attempt.status, 401, `wrong password should be 401, got ${attempt.status}`);
  }
  assert.ok(lockedAt, 'repeated wrong passwords must eventually be rate limited');

  const other = await call('/api/login', { method: 'POST', body: { username: `yok${stamp}`, password: 'sifre123' } });
  assert.strictEqual(other.status, 401, 'the lockout must be per account, not global');
  notes.push(`${lockedAt}. yanlış denemede hesap kilitlendi, başka hesap etkilenmedi`);

  // Security headers are present on the page itself.
  const page = await fetch(`${baseUrl}/`);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('x-frame-options'), 'DENY');
  assert.ok((page.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
  notes.push('güvenlik başlıkları yerinde');

  return notes.join(' · ');
};
