#!/usr/bin/env node
/**
 * End-to-end smoke test for the Space game.
 * Tests the full game loop: contracts -> loadout -> launch -> result -> tree -> repeat.
 * Extends through tier 1, tier 2, and tier 3 (if UI available).
 *
 * Usage: PW_MODULES=... node test/e2e/smoke.mjs
 *
 * Environment variables:
 *   PW_MODULES        - path to node_modules with playwright-core (default: scratchpad)
 *   SMOKE_OUT         - directory for screenshots (default: scratchpad)
 *   SMOKE_PORT        - http.server port (default: 8090)
 *   SMOKE_MAX_ITER    - max gameplay loops for tier 1 (default: 60)
 *   SMOKE_MAX_ITER_T2 - max gameplay loops for tier 2 (default: 120)
 *   SMOKE_MAX_ITER_T3 - max gameplay loops for tier 3 (default: 120)
 *   SMOKE_TURN        - gravity turn value to set on tier 2 loadout (default: 0.45, ignored if no turn slider)
 *   SMOKE_TURN_T3     - gravity turn value for tier 3 loadouts (default: 0.05)
 *   SMOKE_CHEAT       - if set to 1, use window.__space.cheat and pick last contract (default: unset)
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
const MAX_LOOPS_T1 = parseInt(process.env.SMOKE_MAX_ITER || '60', 10);
const MAX_LOOPS_T2 = parseInt(process.env.SMOKE_MAX_ITER_T2 || '120', 10);
const MAX_LOOPS_T3 = parseInt(process.env.SMOKE_MAX_ITER_T3 || '120', 10);
const SMOKE_TURN = parseFloat(process.env.SMOKE_TURN || '0.45');
// Tier 3 flights carry a heavier top stage; a lazier turn keeps periapsis up.
const SMOKE_TURN_T3 = parseFloat(process.env.SMOKE_TURN_T3 || '0.05');
const SMOKE_CHEAT = process.env.SMOKE_CHEAT === '1';
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
  const screens = ['contracts', 'loadout', 'launch', 'result', 'tree', 'win', 'tier'];
  for (const screen of screens) {
    if (await page.$(`[data-screen="${screen}"]`)) {
      return screen;
    }
  }
  return 'unknown';
}

async function getCurrentTier() {
  const tierHud = await page.$('#hud [data-hud="tier"]');
  if (tierHud) {
    const tierText = await tierHud.textContent();
    // Extract tier number from text like "T1", "T2", "T3"
    const match = tierText.match(/T(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  }
  return 1;
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
    const loopCounts = { 1: 0, 2: 0, 3: 0 };
    const maxLoopsPerTier = { 1: MAX_LOOPS_T1, 2: MAX_LOOPS_T2, 3: MAX_LOOPS_T3 };
    let won = false;
    let currentTier = 1;

    while (!won) {
      // Determine loop limit for current tier
      const maxLoops = maxLoopsPerTier[currentTier] || MAX_LOOPS_T1;
      loopCounts[currentTier]++;
      if (loopCounts[currentTier] > maxLoops) {
        errors.push(`Reached max tier ${currentTier} loops (${maxLoops}) without winning`);
        break;
      }
      console.log(`\n=== Tier ${currentTier} Loop ${loopCounts[currentTier]}/${maxLoops} ===`);

      // Wait for contracts screen
      console.log('Waiting for contracts screen...');
      await waitForSelector('[data-screen="contracts"]', TIMEOUT);
      await takeScreenshot('contracts');

      // Select contract
      const contracts = await page.$$('.row[data-contract]');
      if (!contracts.length) {
        throw new Error('No contracts found on screen');
      }

      // Choose a contract. In cheat mode, pick by id priority: the tier goal
      // rung the current state can attempt, falling back down the ladder.
      // Rows are matched by data-contract id, never by text.
      let contractIndex = 0;
      if (SMOKE_CHEAT && contracts.length > 1) {
        const ids = [];
        for (const c of contracts) ids.push(await c.getAttribute('data-contract'));
        const state = await page.evaluate(() => window.__space?.state);
        const hasCore = !!state?.objects?.some(obj => obj.kind === 'core' && !obj.dockedTo);
        const priority = hasCore
          ? ['dock', 'rdv-2', 'rdv-1', 'satellite', 'orbit-goal', 'orbit-low', 'orbit-apogee']
          : ['core', 'satellite', 'orbit-goal', 'orbit-low', 'orbit-apogee', 'orbit-down-2', 'orbit-down-1', 'orbit-entry'];
        contractIndex = contracts.length - 1;
        for (const want of priority) {
          const i = ids.indexOf(want);
          if (i >= 0) { contractIndex = i; break; }
        }
        console.log(`Found ${contracts.length} contract(s) [${ids.join(', ')}], selecting ${ids[contractIndex]} (cheat mode${hasCore ? ', core exists' : ''})...`);
      } else {
        console.log(`Found ${contracts.length} contract(s), selecting first...`);
      }
      await contracts[contractIndex].click();

      // Wait for select button and click it
      console.log('Clicking select button...');
      const selectBtn = await waitForSelector('[data-action="select"]', TIMEOUT);
      await selectBtn.click();

      // Wait for loadout screen
      console.log('Waiting for loadout screen...');
      await waitForSelector('[data-screen="loadout"]', TIMEOUT);
      await takeScreenshot('loadout');

      // Handle loadout sliders
      // Set turn slider if present (tier 2+)
      if (currentTier >= 2) {
        const turnSlider = await page.$('input[type=range][data-loadout="turn"]');
        if (turnSlider) {
          const turnHere = currentTier >= 3 ? SMOKE_TURN_T3 : SMOKE_TURN;
          console.log(`Setting turn slider to ${turnHere}...`);
          await page.evaluate((val) => {
            const elem = document.querySelector('input[type=range][data-loadout="turn"]');
            if (elem) {
              elem.value = val;
              elem.dispatchEvent(new Event('input', { bubbles: true }));
              elem.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, turnHere);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Set window slider if present (tier 3 rendezvous/dock)
      if (currentTier >= 3) {
        const windowSlider = await page.$('input[type=range][data-loadout="window"]');
        if (windowSlider) {
          // The launch window has to match the target's orbital phase: read it
          // from the newest undocked core in state (the value is state, not a
          // prediction), and fall back to 0.5 when there is none.
          const targetPhase = await page.evaluate(() => {
            const objs = window.__space?.state?.objects ?? [];
            const core = [...objs].reverse().find(o => o.kind === 'core' && !o.dockedTo);
            return core ? core.phase : 0.5;
          });
          console.log(`Setting window slider to ${targetPhase.toFixed(2)} (target phase)...`);
          await page.evaluate((v) => {
            const elem = document.querySelector('input[type=range][data-loadout="window"]');
            if (elem) {
              elem.value = v;
              elem.dispatchEvent(new Event('input', { bubbles: true }));
              elem.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, targetPhase);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Click launch button
      console.log('Clicking launch button...');
      const launchBtn = await waitForSelector('[data-action="launch"]', TIMEOUT);
      await launchBtn.click();

      // Wait for launch screen (canvas)
      console.log('Waiting for launch screen...');
      await waitForSelector('canvas#ascent', TIMEOUT);
      await takeScreenshot('launch');

      // Tap canvas to skip ascent animation
      console.log('Tapping canvas to skip ascent playback...');
      const canvas = await page.$('canvas#ascent');
      if (canvas) {
        await canvas.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // For tier 3 with orbital phase, may need to tap canvas again for map view
      if (currentTier >= 3) {
        const canvas2 = await page.$('canvas#ascent');
        if (canvas2) {
          console.log('Tapping canvas again to skip map view...');
          await canvas2.click();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Click continue button to advance from launch to result
      console.log('Clicking continue to go to result...');
      const continueFromLaunch = await waitForSelector('[data-action="continue"]', TIMEOUT);
      await continueFromLaunch.click();

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

      // Check for closest approach if present (tier 3)
      if (currentTier >= 3) {
        const closestApproach = await page.$('[data-result="closest-approach"]');
        if (closestApproach) {
          const caText = await closestApproach.textContent();
          console.log(`Closest approach: ${caText}`);
        }
      }

      // Apply cheat if enabled
      if (SMOKE_CHEAT) {
        const hasCheat = await page.evaluate(() => {
          return typeof window.__space?.cheat === 'function';
        });
        if (hasCheat) {
          console.log('Calling window.__space.cheat({ funds: 200000, reputation: 100 })...');
          await page.evaluate(() => {
            window.__space.cheat({ funds: 200000, reputation: 100 });
          });
        } else {
          console.log('Cheat function not available yet');
        }
      }

      // Click continue on result screen to go to either contracts or win
      console.log('Clicking continue to proceed from result...');
      const resultContinueBtn = await waitForSelector('[data-action="continue"]', TIMEOUT);
      await resultContinueBtn.click();

      // Wait for either contracts, win, or tree screen
      let screenAfterResult = 'unknown';
      let attempts = 0;
      while (screenAfterResult === 'unknown' && attempts < 5) {
        attempts++;
        const contracts = await page.$('[data-screen="contracts"]');
        const win = await page.$('[data-screen="win"]');
        const tree = await page.$('[data-screen="tree"]');
        if (contracts) screenAfterResult = 'contracts';
        else if (win) screenAfterResult = 'win';
        else if (tree) screenAfterResult = 'tree';
        else await new Promise(resolve => setTimeout(resolve, 200));
      }

      if (screenAfterResult === 'win') {
        console.log('Win screen detected!');
        await takeScreenshot('win');

        // Click continue to see if tier interstitial or final win
        const winContinueBtn = await waitForSelector('[data-action="continue"]', TIMEOUT);
        await winContinueBtn.click();

        // Wait for either tier screen (advancement) or contracts (final win)
        let screenAfterWin = 'unknown';
        let tierAttempts = 0;
        while (screenAfterWin === 'unknown' && tierAttempts < 5) {
          tierAttempts++;
          const tier = await page.$('[data-screen="tier"]');
          const contracts = await page.$('[data-screen="contracts"]');
          if (tier) screenAfterWin = 'tier';
          else if (contracts) screenAfterWin = 'contracts';
          else await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (screenAfterWin === 'tier') {
          console.log(`Tier interstitial detected!`);
          await takeScreenshot('tier');

          // Advance tier
          currentTier++;
          console.log(`Advanced to tier ${currentTier}`);

          // Verify tier in HUD
          const tierHud = await page.$('#hud [data-hud="tier"]');
          if (tierHud) {
            const tierText = await tierHud.textContent();
            console.log(`Tier HUD: ${tierText}`);
          }

          // Click continue on tier screen to go to contracts
          const tierContinueBtn = await waitForSelector('[data-action="continue"]', TIMEOUT);
          await tierContinueBtn.click();

          // Wait for contracts to loop again
          console.log(`Waiting for tier ${currentTier} contracts screen...`);
          await waitForSelector('[data-screen="contracts"]', TIMEOUT);
          continue;
        } else if (screenAfterWin === 'contracts') {
          console.log('Final win confirmed (no further tiers)!');
          won = true;
          break;
        } else {
          throw new Error(`Expected tier or contracts screen after win, got ${screenAfterWin}`);
        }
      }

      if (screenAfterResult === 'tree') {
        console.log('Tree screen detected, going back to contracts...');
        const backBtn = await waitForSelector('[data-action="back"]', TIMEOUT);
        await backBtn.click();
        await waitForSelector('[data-screen="contracts"]', TIMEOUT);
        continue;
      }

      if (screenAfterResult !== 'contracts') {
        throw new Error(`Expected contracts screen after result, got ${screenAfterResult}`);
      }

      // We're on contracts screen. Click tree tab to go to tree screen
      console.log('Clicking tree tab to view tech tree...');
      const treeTab = await waitForSelector('[data-tab="tree"]', TIMEOUT);
      await treeTab.click();

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
      console.log('Clicking back button to return to contracts...');
      const backBtn = await waitForSelector('[data-action="back"]', TIMEOUT);
      await backBtn.click();

      // Wait for contracts screen to loop
      console.log('Waiting for contracts screen...');
      await waitForSelector('[data-screen="contracts"]', TIMEOUT);
    }

    // Read final game state
    console.log('\n=== Final State ===');
    const state = await page.evaluate(() => window.__space?.state);
    if (state) {
      const tier = state.tier || 1;
      console.log(`Tier reached: ${tier}`);
      console.log(`Funds: ${state.funds}`);
      console.log(`Reputation: ${state.reputation}`);

      // Launches per tier
      console.log(`Launches:`);
      for (let t = 1; t <= tier; t++) {
        console.log(`  T${t}: ${state.launches[t] || 0}`);
      }

      // Objects in orbit (tier 3+)
      const lastOrbital = await page.evaluate(() => { const o = window.__space?.screens?.view?.outcome; return o?.orbital ? { insertion: o.insertion, dvAvailable: o.orbital.dvAvailable, dvUsed: o.orbital.dvUsed, stoppedAt: o.orbital.stoppedAt, phaseErrorDeg: o.orbital.phaseErrorDeg, closestApproach: o.closestApproach } : null; });
      if (lastOrbital) console.log('Last orbital phase:', JSON.stringify(lastOrbital));
      if (state.objects && state.objects.length > 0) {
        console.log(`Objects in orbit:`);
        state.objects.forEach(obj => {
          const docked = obj.dockedTo ? ` (docked to ${obj.dockedTo})` : '';
          console.log(`  - ${obj.name}${docked}`);
        });
      }

      console.log(`Owned nodes: ${state.owned.join(', ') || 'none'}`);
      console.log(`Best metrics:`);
      console.log(`  Max altitude: ${state.best.maxAltitude || 0}m`);
      if (state.best.maxDownrange !== undefined) {
        console.log(`  Max downrange: ${state.best.maxDownrange || 0}m`);
      }
      if (state.best.bestPeriapsis !== null && state.best.bestPeriapsis !== undefined) {
        console.log(`  Best periapsis: ${state.best.bestPeriapsis}m`);
      }
      if (state.best.bestClosestApproach !== null && state.best.bestClosestApproach !== undefined) {
        console.log(`  Best closest approach: ${state.best.bestClosestApproach}m`);
      }
      if (state.best.docked) {
        console.log(`  Docked: yes`);
      }
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
    const loopParts = [];
    if (loopCounts[1] > 0) loopParts.push(`${loopCounts[1]} T1`);
    if (loopCounts[2] > 0) loopParts.push(`${loopCounts[2]} T2`);
    if (loopCounts[3] > 0) loopParts.push(`${loopCounts[3]} T3`);
    const loopMsg = loopParts.length > 0
      ? `Completed ${loopParts.map(p => `${p} loop(s)`).join(' and ')}`
      : `Completed gameplay loop(s)`;
    console.log(`${loopMsg}${won ? ' and reached win screen' : ''}`);
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
