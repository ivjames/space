import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The service worker's update mechanism is a contract between three files
// that no module imports and no other test loads: sw.js (its CACHE_NAME is
// the per-deploy cache), index.html (its BUILD constant), and bin/space
// (the deploy `sed` that stamps the commit into both). If either
// declaration line drifts from the anchored shape the sed matches, a deploy
// silently stops propagating to installed apps. These tests pin the shape
// from this side, and pin the precache list to the module tree, since a
// module missing from it is fetched through the browser's own HTTP cache
// under cache-first -- the one way a page can run two builds at once.

const root = new URL('..', import.meta.url).pathname;
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const page = readFileSync(join(root, 'index.html'), 'utf8');
const deploy = readFileSync(join(root, 'bin/space'), 'utf8');

// The exact patterns bin/space's two `sed -i` calls use, anchored to the
// start of the line. Kept as literals here rather than parsed out of the
// script: the point is that a change to either side fails this test.
const SW_STAMP = /^const CACHE_NAME = 'space-[^']*';$/m;
const PAGE_STAMP = /^  const BUILD = '[^']*';$/m;

test('sw.js declares CACHE_NAME on exactly the line shape the deploy sed stamps', () => {
  const matches = sw.match(new RegExp(SW_STAMP.source, 'gm')) ?? [];
  assert.equal(matches.length, 1, `expected one anchored CACHE_NAME line, found ${matches.length}`);
  assert.equal(matches[0], "const CACHE_NAME = 'space-dev';", 'the committed worker is the unstamped dev build');
  assert.ok(deploy.includes("^const CACHE_NAME = 'space-"), 'bin/space should grep for the anchored CACHE_NAME line');
  assert.ok(deploy.includes("s/^const CACHE_NAME = 'space-[^']*';/const CACHE_NAME = 'space-$after';/"), 'bin/space should stamp sw.js with the same anchored pattern');
});

test('index.html declares BUILD on exactly the line shape the deploy sed stamps', () => {
  const matches = page.match(new RegExp(PAGE_STAMP.source, 'gm')) ?? [];
  assert.equal(matches.length, 1, `expected one anchored BUILD line, found ${matches.length}`);
  assert.equal(matches[0], "  const BUILD = 'dev';");
  assert.ok(deploy.includes("s/^  const BUILD = '[^']*';/  const BUILD = '$after';/"));
});

test('the dev worker is network-first, and only the dev worker', () => {
  // The name that turns cache-first off must be the committed one and
  // nothing a stamp could produce (commits are hex, 'dev' is not).
  assert.ok(sw.includes("const DEV = CACHE_NAME === 'space-dev';"));
});

test('sw.js precaches every module under js/ and the app shell', () => {
  const listMatch = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
  assert.ok(listMatch, 'PRECACHE_URLS array not found');
  const listed = new Set([...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const modules = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) modules.push(relative(root, p));
    }
  };
  walk(join(root, 'js'));
  assert.ok(modules.length >= 15, `expected the module tree, found ${modules.length} files`);
  for (const m of modules) {
    assert.ok(listed.has(m), `${m} is not in sw.js's PRECACHE_URLS`);
  }
  for (const shell of ['./', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icon.svg']) {
    assert.ok(listed.has(shell), `${shell} is not in sw.js's PRECACHE_URLS`);
  }
  // And nothing listed that does not exist: a 404 fails the whole install.
  for (const url of listed) {
    if (url === './') continue;
    assert.doesNotThrow(() => statSync(join(root, url)), `${url} is listed but does not exist`);
  }
});

test('index.html shows the update prompt only on a controller change after a first install', () => {
  assert.ok(page.includes('id="update"'), 'the prompt element should exist');
  assert.ok(page.includes("addEventListener('controllerchange'"), 'the page should listen for the new worker taking over');
  assert.ok(page.includes('if (!hadController) return;'), 'a first install must not prompt');
});
