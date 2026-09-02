# E2E Smoke Test

An end-to-end browser smoke test for the Space game. Tests the complete gameplay loop across tier 1, tier 2, and tier 3 (when available): contract selection → loadout → launch → result → tree upgrades → repeat, until the final win condition or max iterations per tier.

## What it tests

- **Tier 1 Flow**: contracts → loadout → launch → result → tree → back to contracts
- **Tier 2 Flow** (if UI available): same as tier 1, plus turn slider on loadout, tier interstitial
- **Tier 3 Flow** (if UI available): same as tier 2, plus window slider on loadout, contract selection that avoids dock/rendezvous without a core, map view after ascent playback, closest approach readout
- **UI Navigation**: all stable data-* selectors from ARCHITECTURE.md
- **Selector Stability**: win screen detection, tier interstitial handling, generalized tier loop
- **Game Flow**: launch execution, result readout, node purchasing, win screen, tier progression
- **Error Detection**: collects console errors, page errors, selector timeouts
- **Game State**: reads final `window.__space.state` and reports tier, launches per tier, objects in orbit (name, docking status), owned nodes, best metrics (altitude, downrange, periapsis, closest approach, docking)
- **Cheat Mode** (optional): calls `window.__space.cheat()` and picks harder contracts (with tier 3 logic avoiding dock/rendezvous missions without core) to speed runs

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
SMOKE_CHEAT=1 SMOKE_TURN=0.45 npm run e2e

# With shorter tier limits for quick tests:
SMOKE_MAX_ITER=3 SMOKE_MAX_ITER_T2=3 SMOKE_MAX_ITER_T3=3 npm run e2e
```

Environment variables:
- `PW_MODULES`: path to node_modules containing playwright-core (default: scratchpad)
- `SMOKE_OUT`: directory for screenshots (default: scratchpad)
- `SMOKE_PORT`: starting http.server port (default: 8090)
- `SMOKE_MAX_ITER`: max gameplay loops for tier 1 (default: 60)
- `SMOKE_MAX_ITER_T2`: max gameplay loops for tier 2 (default: 120)
- `SMOKE_MAX_ITER_T3`: max gameplay loops for tier 3 (default: 120)
- `SMOKE_TURN`: gravity turn value to set on loadout (tier 2+) (default: 0.45, ignored if no turn slider exists)
- `SMOKE_CHEAT`: if set to `1`, uses `window.__space.cheat()` to add funds after each result, and picks the LAST (hardest) contract instead of the first (tier 3: avoids dock/rendezvous when no core exists)

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
   - If a tier interstitial appears: takes screenshot, verifies HUD shows new tier, clicks continue, enters next tier's loop
   - If contracts appear directly: declares final win and stops
6. **Tier 2 loop** (up to 120 iterations, or as set by `SMOKE_MAX_ITER_T2`):
   - Same contract/launch/result/tree flow as tier 1
   - On loadout screen: sets the turn slider to `SMOKE_TURN` (0.45 by default) if present
   - Continues until tier 2 final win or max iterations
7. **Tier 3 loop** (up to 120 iterations, or as set by `SMOKE_MAX_ITER_T3`):
   - Same contract/launch/result/tree flow as tier 2
   - Contract selection (with `SMOKE_CHEAT=1`): avoids dock/rendezvous contracts when no core object exists; picks core contract if available, else picks last non-dock/rendezvous contract
   - On loadout screen: sets the window slider to 0.5 if present (tier 3 rendezvous/dock missions)
   - Launch screen: taps canvas once to skip ascent, then again after 500ms to skip map view
   - Result screen: checks for closest approach readout
   - Continues until tier 3 final win or max iterations
8. Reports final game state: tier, launches per tier, objects in orbit (name and docking status), owned nodes, best metrics (altitude, downrange, periapsis, closest approach, docking status)
9. Takes a screenshot the first time each distinct screen is seen, and on failure

## Outputs

- **Exit 0**: Test passed, loop limit or win screen reached, no errors
- **Exit 1**: Selector timeout, console/page error, empty readout, tier interstitial missing when expected, or other assertion failure
- **Screenshots**: Saved to `$SMOKE_OUT` (scratchpad by default) as `smoke-{screen}-{timestamp}.png`
  - Includes: contracts, loadout, launch, result, tree, win, tier (tier 2 interstitial), and failure states

## Not part of `npm test`

This test is separate from the unit test suite (`npm test`). It requires a running HTTP server and a full browser, so it does not run in CI by default. Run it manually to verify the UI works end-to-end.

## Tier 2 and 3 UI dependencies

The test writes against UI hooks from ARCHITECTURE.md. If tier 2 or 3 UI is not yet implemented:
- `[data-screen="tier"]` won't exist; the test will fail looking for the tier interstitial when a tier is unlocked
- `[data-loadout="turn"]` (tier 2+) won't exist; the test will skip the turn slider (no error)
- `[data-loadout="window"]` (tier 3) won't exist; the test will skip the window slider (no error)
- `#hud [data-hud="tier"]` won't exist; the test will log a warning but continue
- `[data-result="closest-approach"]` (tier 3) won't exist; the test will skip logging it (no error)
- `window.__space.cheat` won't exist; the test will log that the cheat is not available yet and continue without it

These are expected and do not indicate a test failure — they mean the UI is still under development. Once the hooks are added, re-run the test.
