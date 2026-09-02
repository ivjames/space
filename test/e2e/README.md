# E2E Smoke Test

An end-to-end browser smoke test for the Space game. Tests the complete gameplay loop across tier 1 and tier 2 (when available): contract selection → loadout → launch → result → tree upgrades → repeat, until the final win condition or max iterations per tier.

## What it tests

- **Tier 1 Flow**: contracts → loadout → launch → result → tree → back to contracts
- **Tier 2 Flow** (if UI available): same as tier 1, plus turn slider on loadout, tier interstitial
- **UI Navigation**: all stable data-* selectors from ARCHITECTURE.md
- **Selector Stability**: win screen detection, tier interstitial handling
- **Game Flow**: launch execution, result readout, node purchasing, win screen, tier progression
- **Error Detection**: collects console errors, page errors, selector timeouts
- **Game State**: reads final `window.__space.state` and reports tier, launches per tier, owned nodes, best altitude, best periapsis
- **Cheat Mode** (optional): calls `window.__space.cheat()` and picks harder contracts to speed runs

## Running it

The test requires `playwright-core` and `chromium`. These are not in the repo's npm dependencies.

```bash
# If playwright-core is installed in the scratchpad (default):
npm run e2e

# Or with a custom playwright path:
PW_MODULES=/path/to/pw/node_modules npm run e2e

# Or with custom settings:
PW_MODULES=... SMOKE_OUT=/tmp/screenshots SMOKE_PORT=9000 SMOKE_MAX_ITER=30 npm run e2e

# With cheat mode enabled (speeds up runs):
SMOKE_CHEAT=1 SMOKE_TURN=0.5 npm run e2e

# With shorter tier limits for quick tests:
SMOKE_MAX_ITER=3 SMOKE_MAX_ITER_T2=3 npm run e2e
```

Environment variables:
- `PW_MODULES`: path to node_modules containing playwright-core (default: scratchpad)
- `SMOKE_OUT`: directory for screenshots (default: scratchpad)
- `SMOKE_PORT`: starting http.server port (default: 8090)
- `SMOKE_MAX_ITER`: max gameplay loops for tier 1 (default: 60)
- `SMOKE_MAX_ITER_T2`: max gameplay loops for tier 2 (default: 120)
- `SMOKE_TURN`: gravity turn value to set on tier 2 loadout (default: 0.4, ignored if no turn slider exists)
- `SMOKE_CHEAT`: if set to `1`, uses `window.__space.cheat()` to add funds after each result, and picks the LAST (hardest) contract instead of the first

## What it needs

1. **Chromium**: Must be preinstalled at `/opt/pw-browsers` or accessible via `PLAYWRIGHT_BROWSERS_PATH`
2. **playwright-core**: Not in the repo; pass via `PW_MODULES` or install to scratchpad first:
   ```bash
   mkdir -p /tmp/space-pw && cd /tmp/space-pw
   npm init -y
   npm i playwright-core
   PW_MODULES=/tmp/space-pw/node_modules npm run e2e
   ```
3. **Python 3**: to run http.server (comes with most systems)

## What it does

1. Starts a local Python HTTP server on a free port (8090 by default)
2. Launches headless Chromium with a mobile viewport (360×740)
3. Navigates to the game and waits for the contracts screen
4. **Tier 1 loop** (up to 60 iterations, or as set by `SMOKE_MAX_ITER`):
   - Selects a contract (first by default; last if `SMOKE_CHEAT=1`)
   - Launches the rocket
   - Skips the ascent animation
   - Checks the result readout is non-empty
   - Optionally applies cheat funds if enabled
   - Opens the tree and buys any available node
   - Returns to contracts
5. On tier 1 win:
   - Takes screenshot
   - Clicks continue
   - If a tier 2 interstitial appears: takes screenshot, verifies HUD shows T2, clicks continue, enters tier 2 loop
   - If contracts appear directly: declares final win and stops
6. **Tier 2 loop** (up to 120 iterations, or as set by `SMOKE_MAX_ITER_T2`):
   - Same contract/launch/result/tree flow as tier 1
   - On loadout screen: sets the turn slider to `SMOKE_TURN` (0.4 by default) if present
   - Continues until phase 1 final win or max iterations
7. Reports final game state: tier, launches per tier, funds, reputation, owned nodes, best altitude, best periapsis
8. Takes a screenshot the first time each distinct screen is seen, and on failure

## Outputs

- **Exit 0**: Test passed, loop limit or win screen reached, no errors
- **Exit 1**: Selector timeout, console/page error, empty readout, tier interstitial missing when expected, or other assertion failure
- **Screenshots**: Saved to `$SMOKE_OUT` (scratchpad by default) as `smoke-{screen}-{timestamp}.png`
  - Includes: contracts, loadout, launch, result, tree, win, tier (tier 2 interstitial), and failure states

## Not part of `npm test`

This test is separate from the unit test suite (`npm test`). It requires a running HTTP server and a full browser, so it does not run in CI by default. Run it manually to verify the UI works end-to-end.

## Tier 2 UI dependencies

The test writes against UI hooks from ARCHITECTURE.md. If tier 2 UI is not yet implemented:
- `[data-screen="tier"]` won't exist; the test will fail looking for the tier interstitial
- `[data-loadout="turn"]` won't exist; the test will skip the turn slider (no error)
- `#hud [data-hud="tier"]` won't exist; the test will log a warning but continue
- `window.__space.cheat` won't exist; the test will log that the cheat is not available yet and continue without it

These are expected and do not indicate a test failure — they mean the UI is still under development. Once the hooks are added, re-run the test.
