# E2E Smoke Test

An end-to-end browser smoke test for the Space game. Tests the complete gameplay loop: contract selection → loadout → launch → result → tree upgrades → repeat, until the tier 1 win condition or max iterations.

## What it tests

- **UI Navigation**: contracts → loadout → launch → result → tree → back to contracts
- **Selector Stability**: all interactions use the stable data-* selectors from ARCHITECTURE.md
- **Game Flow**: launch execution, result readout, node purchasing, win screen
- **Error Detection**: collects console errors, page errors, selector timeouts
- **Game State**: reads final `window.__space.state` and reports funds, reputation, launches, owned nodes, best altitude

## Running it

The test requires `playwright-core` and `chromium`. These are not in the repo's npm dependencies.

```bash
# If playwright-core is installed in the scratchpad (default):
npm run e2e

# Or with a custom playwright path:
PW_MODULES=/path/to/pw/node_modules npm run e2e

# Or with custom settings:
PW_MODULES=... SMOKE_OUT=/tmp/screenshots SMOKE_PORT=9000 SMOKE_LOOPS=30 npm run e2e
```

Environment variables:
- `PW_MODULES`: path to node_modules containing playwright-core (default: scratchpad)
- `SMOKE_OUT`: directory for screenshots (default: scratchpad)
- `SMOKE_PORT`: starting http.server port (default: 8090)
- `SMOKE_LOOPS`: max gameplay loops (default: 60)

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
4. Runs up to 60 gameplay loops:
   - Selects a contract
   - Launches the rocket
   - Skips the ascent animation
   - Checks the result readout is non-empty
   - Opens the tree and buys any available node
   - Returns to contracts
5. Stops if the win screen appears or max loops reached
6. Reports final game state: funds, reputation, launches, owned nodes, best altitude
7. Takes a screenshot the first time each distinct screen is seen, and on failure

## Outputs

- **Exit 0**: Test passed, loop limit or win screen reached, no errors
- **Exit 1**: Selector timeout, console/page error, empty readout, or other assertion failure
- **Screenshots**: Saved to `$SMOKE_OUT` (scratchpad by default) as `smoke-{screen}-{timestamp}.png`

## Not part of `npm test`

This test is separate from the unit test suite (`npm test`). It requires a running HTTP server and a full browser, so it does not run in CI by default. Run it manually to verify the UI works end-to-end.
