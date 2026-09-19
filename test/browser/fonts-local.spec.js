/**
 * The page must not reach out to anybody to render itself.
 *
 * The fonts came from Google on every page load. That made the game depend on a
 * third party being up to draw its own text, and sent every visitor's browser —
 * with their IP — to that third party without them choosing to. Both are
 * reasons to serve our own copies.
 *
 * This watches the real network: a link left behind in the HTML, a CSS file
 * still pointing at gstatic, or a stylesheet that silently failed would all
 * show up here.
 */
const assert = require('assert');
const { VIEWPORT } = require('./helpers');

// Turkish is the whole point of keeping latin-ext. If a face cannot draw these,
// the page falls back to a system font and the game looks broken.
const TURKISH = 'şŞğĞıİçÇöÖüÜ';

module.exports.needsDatabase = false;
module.exports.run = async ({ browser, baseUrl }) => {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    const external = [];
    const failed = [];
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith(baseUrl) && !url.startsWith('data:') && !url.startsWith('blob:')) {
        external.push(`${req.resourceType()} ${url}`);
      }
    });
    page.on('requestfailed', (req) => failed.push(`${req.url()} — ${req.failure() && req.failure().errorText}`));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-lobby.active', { timeout: 15000 });

    assert.deepStrictEqual(external, [],
      `the page requested something from outside:\n  ${external.join('\n  ')}`);
    assert.deepStrictEqual(failed, [],
      `requests failed:\n  ${failed.join('\n  ')}`);

    // The fonts were really fetched from us, and really loaded.
    const fontRequests = await page.evaluate(() => performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('/fonts/'))
      .map((e) => e.name.split('/').pop()));
    assert.ok(fontRequests.length > 0, 'no font file was loaded at all');

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded')
        .map((f) => `${f.family} ${f.weight}`);
    });
    assert.ok(loaded.some((f) => /Anton/.test(f)), `Anton did not load (${loaded.join(', ')})`);
    assert.ok(loaded.some((f) => /Inter/.test(f)), `Inter did not load (${loaded.join(', ')})`);

    // And the Turkish letters are drawn by that font rather than a fallback:
    // measured against a deliberately missing family, the widths must differ.
    const rendersTurkish = await page.evaluate(async (text) => {
      await document.fonts.ready;
      const measure = (family) => {
        const el = document.createElement('span');
        el.textContent = text;
        el.style.cssText = `position:absolute;visibility:hidden;font-size:64px;font-family:${family}`;
        document.body.appendChild(el);
        const width = el.getBoundingClientRect().width;
        el.remove();
        return width;
      };
      return {
        inter: measure("'Inter', 'NoSuchFamily', monospace"),
        fallback: measure("'NoSuchFamily', monospace"),
      };
    }, TURKISH);

    assert.ok(rendersTurkish.inter > 0, 'the Turkish letters measured zero width');
    assert.notStrictEqual(rendersTurkish.inter, rendersTurkish.fallback,
      'the Turkish letters fell back to a system font — latin-ext is not loading');

    return `dış istek yok (${fontRequests.length} yazı tipi kendi sunucumuzdan), Anton+Inter yüklendi, "${TURKISH}" gerçek yüzle çiziliyor`;
  } finally {
    await context.close();
  }
};
