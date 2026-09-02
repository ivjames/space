#!/usr/bin/env node
/**
 * End-to-end smoke test for the Space game.
 * Tests the full game loop: contracts -> loadout -> launch -> result -> tree -> repeat.
 *
 * Usage: PW_MODULES=... node test/e2e/smoke.mjs
 *
 * Environment variables:
 *   PW_MODULES    - path to node_modules with playwright-core (default: scratchpad)
 *   SMOKE_OUT     - directory for screenshots (default: scratchpad)
 *   SMOKE_PORT    - http.server port (default: 8090)
 *   SMOKE_LOOPS   - max gameplay loops (default: 60)
 */

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../');
const scratchpad = '/tmp/claude-0/-home-user-lab980-com/fb44f581-df79-5961-ae88-77cf7cc8505c/scratchpad';

// Configuration
const PW_MODULES = process.env.PW_MODULES || path.join(scratchpad, 'pw/node_modules');
const SMOKE_OUT = process.env.SMOKE_OUT || scratchpad;
const SMOKE_PORT = parseInt(process.env.SMOKE_PORT || '8090', 10);
const MAX_LOOPS = parseInt(process.env.SMOKE_LOOPS || '60', 10);
const TIMEOUT = 10000; // 10 second timeout for selectors

// Import playwright-core dynamically
let playwright;
try {
  const require = createRequire(import.meta.url);
  playwright = require(path.join(PW_MODULES, 'playwright-core'));
} catch (e) {
  console.error(`Failed to load playwright-core from ${PW_MODULES}: ${e.message}`);
  process.exit(1);
}

// Browser and server instances
let browser, page, serverProcess;
const errors = [];
const screenshots = new Set();

// Cleanup function
async function cleanup(code = 0) {
  try {
    if (page) await page.close();
    if (browser) await browser.close();
  } catch (e) {
    // Ignore close errors
  }

  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    // Give it 1 second to die
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }

  process.exit(code);
}

// Signal handlers
process.on('SIGINT', () => cleanup(1));
process.on('SIGTERM', () => cleanup(1));

async function findFreePort(startPort) {
  // Try the requested port first, then increment
  for (let port = startPort; port < startPort + 100; port++) {
    try {
      const net = await import('net');
      const server = net.createServer();
      return await new Promise((resolve, reject) => {
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(port));
        });
        server.on('error', () => reject(new Error(`Port ${port} in use`)));
      });
    } catch (e) {
      continue;
    }
  }
  throw new Error(`No free ports found starting from ${startPort}`);
}

async function startServer(port) {
  return new Promise((resolve, reject) => {
    serverProcess = spawn('python3', ['-m', 'http.server', String(port)], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) reject(new Error(`Server did not start within 5s on port ${port}`));
    }, 5000);

    serverProcess.stdout.on('data', (data) => {
      if (!ready && data.toString().includes('Serving')) {
        ready = true;
        clearTimeout(timeout);
        resolve(port);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      if (!ready) reject(new Error(`Server error: ${data}`));
    });

    serverProcess.on('error', reject);
  });
}

async function waitForSelector(selector, timeout = TIMEOUT) {
  try {
    await page.waitForSelector(selector, { timeout });
    return await page.$(selector);
  } catch (e) {
    throw new Error(`Selector timeout: ${selector}`);
  }
}

async function getScreenName() {
  const screens = ['contracts', 'loadout', 'launch', 'result', 'tree', 'win'];
  for (const screen of screens) {
    if (await page.$(`[data-screen="${screen}"]`)) {
      return screen;
    }
  }
  return 'unknown';
}

async function takeScreenshot(name) {
  if (!screenshots.has(name)) {
    const outPath = path.join(SMOKE_OUT, `smoke-${name}-${Date.now()}.png`);
    await page.screenshot({ path: outPath });
    screenshots.add(name);
  }
}

async function runSmokeTest() {
  try {
    // Find a free port
    const port = await findFreePort(SMOKE_PORT);
    console.log(`Starting server on port ${port}...`);
    await startServer(port);

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Launch browser
    console.log('Launching browser...');
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath: '/opt/pw-browsers/chromium',
    });

    page = await browser.newPage({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
    });

    // Collect errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`Console error: ${msg.text()}`);
      }
    });

    page.on('pageerror', (err) => {
      errors.push(`Page error: ${err.message}`);
    });

    // Navigate
    console.log(`Navigating to http://127.0.0.1:${port}/`);
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    // Main gameplay loop
    let loopCount = 0;
    let won = false;

    while (loopCount < MAX_LOOPS && !won) {
      loopCount++;
      console.log(`\n=== Loop ${loopCount}/${MAX_LOOPS} ===`);

      // Wait for contracts screen
      console.log('Waiting for contracts screen...');
      await waitForSelector('[data-screen="contracts"]', TIMEOUT);
      await takeScreenshot('contracts');

      // Select first contract
      const contracts = await page.$$('.row[data-contract]');
      if (!contracts.length) {
        throw new Error('No contracts found on screen');
      }
      console.log(`Found ${contracts.length} contract(s), selecting first...`);
      await contracts[0].click();

      // Wait for select button and click it
      console.log('Clicking select button...');
      const selectBtn = await waitForSelector('[data-action="select"]', TIMEOUT);
      await selectBtn.click();

      // Wait for loadout screen
      console.log('Waiting for loadout screen...');
      await waitForSelector('[data-screen="loadout"]', TIMEOUT);
      await takeScreenshot('loadout');

      // Click launch button
      console.log('Clicking launch button...');
      const launchBtn = await waitForSelector('[data-action="launch"]', TIMEOUT);
      await launchBtn.click();

      // Wait for launch screen (canvas)
      console.log('Waiting for launch screen...');
      await waitForSelector('canvas#ascent', TIMEOUT);
      await takeScreenshot('launch');

      // Tap canvas to skip animation
      console.log('Tapping canvas to skip...');
      const canvas = await page.$('canvas#ascent');
      if (canvas) {
        await canvas.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Wait for result screen
      console.log('Waiting for result screen...');
      await waitForSelector('[data-screen="result"]', TIMEOUT);
      await takeScreenshot('result');

      // Verify readout exists
      const readout = await page.$('.readout[data-readout]');
      if (!readout) {
        throw new Error('No readout found on result screen');
      }
      const readoutText = await readout.textContent();
      console.log(`Readout: ${readoutText}`);

      if (!readoutText || readoutText.trim().length === 0) {
        throw new Error('Readout is empty');
      }

      // Check if we've won
      const winScreen = await page.$('[data-screen="win"]');
      if (winScreen) {
        console.log('Win screen detected!');
        await takeScreenshot('win');
        won = true;

        // Tap continue to confirm the win flow
        const continueBtn = await waitForSelector('[data-action="continue"]', TIMEOUT);
        await continueBtn.click();
        break;
      }

      // Click continue to go to tree
      console.log('Clicking continue to go to tree...');
      const continueBtn = await waitForSelector('[data-action="continue"]', TIMEOUT);
      await continueBtn.click();

      // Wait for tree screen
      console.log('Waiting for tree screen...');
      await waitForSelector('[data-screen="tree"]', TIMEOUT);
      await takeScreenshot('tree');

      // Try to buy a node from the tree
      console.log('Looking for buyable nodes...');
      const buyableNodes = await page.$$('.row.buyable[data-node]');
      if (buyableNodes.length > 0) {
        console.log(`Found ${buyableNodes.length} buyable node(s), buying first...`);
        await buyableNodes[0].click();
        await new Promise(resolve => setTimeout(resolve, 300));
      } else {
        console.log('No buyable nodes available');
      }

      // Click back to return to contracts
      console.log('Clicking back button...');
      const backBtn = await waitForSelector('[data-action="back"]', TIMEOUT);
      await backBtn.click();
    }

    if (loopCount >= MAX_LOOPS && !won) {
      errors.push(`Reached max loops (${MAX_LOOPS}) without winning`);
    }

    // Read final game state
    console.log('\n=== Final State ===');
    const state = await page.evaluate(() => window.__space?.state);
    if (state) {
      console.log(`Funds: ${state.funds}`);
      console.log(`Reputation: ${state.reputation}`);
      console.log(`Launches: ${JSON.stringify(state.launches)}`);
      console.log(`Owned nodes: ${state.owned.join(', ') || 'none'}`);
      console.log(`Best altitude: ${state.best.maxAltitude}m`);
    } else {
      console.warn('Could not read game state');
    }

    // Check for errors
    if (errors.length > 0) {
      console.error('\n=== Errors ===');
      errors.forEach(err => console.error(`  - ${err}`));
      await cleanup(1);
    }

    console.log(`\n=== SUCCESS ===`);
    console.log(`Completed ${loopCount} gameplay loop(s)${won ? ' and reached win screen' : ''}`);
    await cleanup(0);

  } catch (err) {
    console.error(`FATAL: ${err.message}`);

    // Take screenshot on failure
    try {
      const screenName = await getScreenName();
      await takeScreenshot(`failure-${screenName}`);
    } catch (e) {
      // Ignore screenshot errors on failure
    }

    await cleanup(1);
  }
}

// Start the test
runSmokeTest();
