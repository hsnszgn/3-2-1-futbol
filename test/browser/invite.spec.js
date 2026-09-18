/**
 * The invite flow, which is how this game actually spreads.
 *
 * It has broken twice in production: the code was dropped when the host
 * backgrounded their browser to share the link, and the invited player got
 * "oda bulunamadı". This drives the real share path.
 */
const assert = require('assert');
const { twoPlayers, sleep } = require('./helpers');

module.exports.needsDatabase = false;
module.exports.run = async ({ browser, baseUrl }) => {
  const { pageA, pageB, errors, close } = await twoPlayers(browser, baseUrl);
  try {
    // The host has no Web Share API in headless Chromium, so the client falls
    // back to the clipboard. Capture what it would have copied.
    await pageA.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await pageA.fill('#nameInput', 'Ali');
    await pageA.click('#btnCreateRoom');
    await pageA.waitForSelector('#roomCodeDisplay', { timeout: 15000 });
    await pageA.waitForFunction(
      () => (document.getElementById('roomCodeDisplay').textContent || '').trim().length > 0,
      { timeout: 15000 },
    );
    const code = (await pageA.textContent('#roomCodeDisplay')).trim();
    assert.ok(code.length >= 4, `invite code looks wrong: "${code}"`);

    // The invited player follows the link, exactly as they would from WhatsApp.
    await pageB.goto(`${baseUrl}/?oda=${code}`);
    await pageB.waitForSelector('#inviteBanner:not(.hidden)', { timeout: 15000 });
    const banner = (await pageB.textContent('#inviteCode')).trim();
    assert.strictEqual(banner, code, 'the landing page should show the invited code');

    await pageB.fill('#nameInput', 'Veli');
    await pageB.click('#btnJoinRoom');

    await Promise.all([
      pageA.waitForSelector('#screen-game.active', { timeout: 20000 }),
      pageB.waitForSelector('#screen-game.active', { timeout: 20000 }),
    ]);
    await sleep(300);
    const oppName = (await pageA.textContent('#oppName')).trim();
    assert.strictEqual(oppName, 'Veli', `host should see the guest's name, got "${oppName}"`);

    assert.deepStrictEqual(errors, [], `client errors: ${errors.join(' | ')}`);
    return `davet kodu ${code}; link ile katılım çalıştı, iki oyuncu da oyunda`;
  } finally {
    await close();
  }
};
