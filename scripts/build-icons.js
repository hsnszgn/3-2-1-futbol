#!/usr/bin/env node
/**
 * Renders the app icons and the social share image.
 *
 * The manifest and the Open Graph tags both point at PNGs: iOS home screens
 * and WhatsApp link previews will not take an SVG. Rather than commit binaries
 * nobody can diff, they are generated here from the same brand values the rest
 * of the app uses, using the Chromium that Playwright already provides.
 *
 * Run with: npm run build:icons
 */
const fs = require('fs');
const path = require('path');
const brand = require('../config/brand');

const OUT = path.join(__dirname, '..', 'public');

// The icon is drawn as a page rather than an SVG file so the share image can
// reuse the same type and colours without a second source of truth.
function iconHtml(size) {
  const ring = Math.round(size * 0.045);
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;}
    body{display:grid;place-items:center;background:${brand.backgroundColor};}
    .disc{width:${size}px;height:${size}px;border-radius:22%;background:${brand.backgroundColor};
      display:grid;place-items:center;box-sizing:border-box;border:${ring}px solid ${brand.themeColor};}
    .mark{font:800 ${Math.round(size * 0.34)}px/1 system-ui,sans-serif;color:${brand.themeColor};
      letter-spacing:-0.02em;}
  </style><div class="disc"><span class="mark">321</span></div>`;
}

function shareHtml() {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:1200px;height:630px;}
    body{background:${brand.backgroundColor};color:#f5f4f0;display:flex;flex-direction:column;
      justify-content:center;gap:28px;padding:0 90px;box-sizing:border-box;
      font-family:system-ui,-apple-system,sans-serif;}
    .name{font-size:104px;font-weight:800;letter-spacing:-0.02em;line-height:1;}
    .name span{color:${brand.themeColor};}
    .tag{font-size:38px;line-height:1.35;color:#9a9aa8;max-width:900px;}
    .rule{width:120px;height:10px;background:${brand.themeColor};border-radius:99px;}
  </style>
  <div class="rule"></div>
  <div class="name">3<span>·</span>2<span>·</span>1 FUTBOL</div>
  <div class="tag">${brand.tagline}</div>`;
}

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();

  const jobs = [
    { file: 'icon-192.png', width: 192, height: 192, html: iconHtml(192) },
    { file: 'icon-512.png', width: 512, height: 512, html: iconHtml(512) },
    { file: 'og.png', width: 1200, height: 630, html: shareHtml() },
  ];

  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.width, height: job.height } });
    await page.setContent(job.html);
    await page.screenshot({ path: path.join(OUT, job.file) });
    await page.close();
    const size = fs.statSync(path.join(OUT, job.file)).size;
    console.log(`${job.file.padEnd(14)} ${job.width}x${job.height}  ${(size / 1024).toFixed(1)} KB`);
  }

  await browser.close();
})().catch((err) => {
  // Icons are a build convenience, not a runtime dependency: a machine without
  // Playwright should not fail the whole install.
  console.error('Ikonlar uretilemedi:', err.message);
  console.error('Playwright kurulu degilse: npm i -D playwright');
  process.exit(1);
});
