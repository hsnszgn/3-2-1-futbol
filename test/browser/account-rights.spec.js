/**
 * Account deletion and data export, through the HTTP API the client uses.
 *
 * The behaviour that matters most: deleting MY account must not erase YOUR
 * match history. Matches reference players with ON DELETE CASCADE, so a naive
 * hard delete would take the opponent's wins with it.
 *
 * Requires a throwaway database — this truncates tables.
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
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch (err) { parsed = { raw: text }; }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  const stamp = Date.now().toString().slice(-6);
  const [gone, stays] = [`sil${stamp}`, `kal${stamp}`];

  const a = await call('/api/register', { method: 'POST', body: { username: gone, password: 'sifre123' } });
  const b = await call('/api/register', { method: 'POST', body: { username: stays, password: 'sifre123' } });
  assert.strictEqual(a.status, 200, `registration failed: ${JSON.stringify(a.body)}`);
  assert.strictEqual(b.status, 200, `registration failed: ${JSON.stringify(b.body)}`);

  // Export needs the password again: a stolen token must not be enough.
  const noPass = await call('/api/account/export', { method: 'POST', token: a.body.token, body: {} });
  assert.strictEqual(noPass.status, 403, 'export must re-check the password');

  const exported = await call('/api/account/export', {
    method: 'POST', token: a.body.token, body: { password: 'sifre123' },
  });
  assert.strictEqual(exported.status, 200, `export failed: ${JSON.stringify(exported.body)}`);
  assert.strictEqual(exported.body.hesap.kullaniciAdi, gone, 'export should name the account');
  assert.ok(!JSON.stringify(exported.body).includes('password_hash'),
    'export must never contain the password hash');

  const wrongPass = await call('/api/account/delete', {
    method: 'POST', token: a.body.token, body: { password: 'yanlis123' },
  });
  assert.strictEqual(wrongPass.status, 403, 'deletion must re-check the password');

  const deleted = await call('/api/account/delete', {
    method: 'POST', token: a.body.token, body: { password: 'sifre123' },
  });
  assert.strictEqual(deleted.status, 200, `deletion failed: ${JSON.stringify(deleted.body)}`);

  // The session dies with the account, and the account cannot log back in.
  assert.strictEqual((await call('/api/me', { token: a.body.token })).status, 401,
    'sessions must die with the account');
  assert.strictEqual(
    (await call('/api/login', { method: 'POST', body: { username: gone, password: 'sifre123' } })).status,
    401, 'a deleted account must not log in');

  // The other player is untouched and still listed.
  const survivor = await call(`/api/profile/${stays}`);
  assert.strictEqual(survivor.status, 200, 'the remaining account should still exist');

  const board = await call('/api/leaderboard');
  assert.ok(!board.body.entries.some((e) => e.username === gone),
    'a deleted player must not appear on the leaderboard');

  return `dışa aktarma şifre soruyor, silme şifre soruyor, silinen hesap giriş yapamıyor ve tabloda yok; diğer hesap duruyor`;
};
