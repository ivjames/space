#!/usr/bin/env node
// A browser check of the BASE tab (phase 3b) — the one screen test/e2e/smoke.mjs
// never reaches, because reaching it in play means winning three tiers and
// flying a survey.
//
// WHY IT IS SEPARATE FROM smoke.mjs. That script plays the game: it clicks
// through contracts, watches flights and buys nodes, and what it proves is
// that the loop works. This one does not play anything — it plants a state and
// looks at what is drawn. The base tab has no flight, no rng and no playback,
// so there is nothing to play; what can go wrong is a template literal that
// throws, a number formatted as NaN, or a button that does not do what it
// says. Those are what this checks.
//
// It is NOT in `npm test`: it needs a browser. Run it the way the smoke test
// is run —
//
//   PW_MODULES=<path to a playwright-core install> node test/e2e/base-tab.mjs
//
// — and it exits non-zero on the first thing that is wrong.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PW_MODULES = process.env.PW_MODULES || path.join(process.cwd(), 'node_modules');
const require = createRequire(`${PW_MODULES}/`);
const { chromium } = require('playwright-core');
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const PORT = parseInt(process.env.SMOKE_PORT || '8099', 10);

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-tab="base"]');

// 1. Before any survey.
await page.click('[data-tab="base"]');
await page.waitForSelector('[data-screen="base"]');
const empty = await page.textContent('[data-screen="base"]');
console.log('empty tab says:', /No ground surveyed/.test(empty) ? 'OK' : `WRONG: ${empty.slice(0, 120)}`);

// 2. With a surveyed site and a stocked base.
await page.evaluate(() => {
  const s = window.__space.state;
  const next = {
    ...s,
    tier: 4,
    funds: 500000,
    sites: { 'mare-tranquil': { surveyed: true }, 'shackleton-rim': { surveyed: true } },
    bases: {
      'mare-tranquil': {
        equipment: { power: 2, extractor: 1, processor: 1, storage: 2, transport: 0 },
        store: { water: 10, fuel: 30, oxidizer: 240, metals: 900 },
      },
    },
  };
  // No public setter; the screens read through getState, so replace via the
  // same path the UI uses.
  window.__space.cheat({ funds: 0 });
  Object.assign(window.__space.state, next);
  window.__space.screens.render();
});
await page.click('[data-tab="contracts"]');
await page.click('[data-tab="base"]');
await page.waitForSelector('[data-screen="base"]');
const raw = await page.textContent('[data-screen="base"]');
// The markup wraps, so a rendered sentence carries newlines and indentation.
// Every check below is about WHAT it says, not how it was wrapped.
const text = raw.replace(/\s+/g, ' ');
const html = await page.innerHTML('[data-screen="base"]');

const checks = [
  ['names the built site', /Mare Tranquillitatis/.test(text)],
  ['names the unbuilt surveyed site', /Shackleton Rim/.test(text)],
  ['shows the site numbers', /Water 1\.00×/.test(text)],
  ['shows the power balance', /Power 20 supplied, 9 drawn/.test(text)],
  ['lists all five equipment types', ['power', 'extractor', 'processor', 'storage', 'transport']
    .every((t) => html.includes(`data-build="mare-tranquil:${t}"`))],
  // transport is at level 0, so its NEXT level is the first one -- a payload,
  // priced in funds. Everything else is already built, so its next level is
  // priced in metals, on site. Both purses on one screen.
  ['prices the first level of anything in funds', /140,000 funds/.test(text)],
  ['prices every level after it in metals', /640 metals/.test(text)],
  ['draws the four tanks', (html.match(/class="tank/g) ?? []).length >= 4],
  ['says the unbuilt site has no base', /No base here yet/.test(text)],
];
let bad = 0;
for (const [what, ok] of checks) { console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`); if (!ok) bad += 1; }

// 3. A build click actually raises a level.
const before = await page.evaluate(() => window.__space.state.bases['mare-tranquil'].equipment.storage);
await page.click('[data-build="mare-tranquil:storage"]');
const after = await page.evaluate(() => window.__space.state.bases['mare-tranquil'].equipment.storage);
console.log(`${after === before + 1 ? 'OK  ' : 'FAIL'} building storage raises the level (${before} -> ${after})`);
if (after !== before + 1) bad += 1;

if (errors.length) { console.log('PAGE ERRORS:', errors.slice(0, 5)); bad += 1; }
console.log(bad === 0 ? '\nBASE TAB: PASS' : `\nBASE TAB: ${bad} FAILURE(S)`);
await browser.close();
server.close();
process.exit(bad === 0 ? 0 : 1);
