/**
 * Shared helpers for the browser specs.
 *
 * Every spec drives two real Chromium contexts, because this is a two-player
 * game and most of its interesting failures — a submit that silently does
 * nothing, a round that ends for one side only — only appear when two clients
 * are genuinely racing each other.
 */
const VIEWPORT = { width: 390, height: 844 };

/** Two independent players, each in their own browser context. */
async function twoPlayers(browser, baseUrl) {
  const contexts = await Promise.all([
    browser.newContext({ viewport: VIEWPORT }),
    browser.newContext({ viewport: VIEWPORT }),
  ]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const errors = [];
  pages.forEach((p, i) => p.on('pageerror', (e) => errors.push(`[p${i + 1}] ${e.message}`)));
  await Promise.all(pages.map((p) => p.goto(baseUrl)));
  return {
    pageA: pages[0],
    pageB: pages[1],
    errors,
    async close() {
      await Promise.all(contexts.map((c) => c.close()));
    },
  };
}

/** Queue both players and wait until the game screen is up for both. */
async function startGame(pageA, pageB, names = ['Ali', 'Veli']) {
  await pageA.fill('#nameInput', names[0]);
  await pageB.fill('#nameInput', names[1]);
  await pageA.click('#btnQuickMatch');
  await pageB.click('#btnQuickMatch');
  await Promise.all([
    pageA.waitForSelector('#screen-game.active', { timeout: 20000 }),
    pageB.waitForSelector('#screen-game.active', { timeout: 20000 }),
  ]);
}

/**
 * Plays one round to completion, with `winner` giving the correct answer.
 * Returns the text the loser was shown, which is where several past bugs hid.
 */
async function playRound(pageA, pageB, { teamA, teamB, guess, winner = 'A' } = {}) {
  const fast = winner === 'A' ? pageA : pageB;
  const slow = winner === 'A' ? pageB : pageA;

  await pageA.waitForSelector('#teamPhase:not(.hidden)', { timeout: 25000 });
  await pageA.fill('#teamInput', teamA);
  await pageA.click('#btnSubmitTeam');
  await pageB.fill('#teamInput', teamB);
  await pageB.click('#btnSubmitTeam');

  await fast.waitForSelector('#guessPhase:not(.hidden)', { timeout: 25000 });
  await fast.fill('#guessInput', guess);
  await fast.click('#btnSubmitGuess');

  await fast.waitForSelector('#resultPhase:not(.hidden)', { timeout: 25000 });
  await slow.waitForSelector('#resultPhase:not(.hidden)', { timeout: 25000 });

  return {
    winnerText: (await fast.textContent('#resultText')).trim(),
    loserText: (await slow.textContent('#resultText')).trim(),
  };
}

/** Registers an account through the real UI and waits for the card to appear. */
async function register(page, username, password = 'sifre123') {
  await page.waitForSelector('#btnAuth:not(.hidden)', { timeout: 15000 });
  await page.click('#btnAuth');
  await page.click('#tabRegister');
  await page.fill('#authUsername', username);
  await page.fill('#authPassword', password);
  await page.click('#btnAuthSubmit');
  await page.waitForSelector('#accountCard:not(.hidden)', { timeout: 15000 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { VIEWPORT, twoPlayers, startGame, playRound, register, sleep };
