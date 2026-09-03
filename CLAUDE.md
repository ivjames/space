# Space — working notes

A launch-and-upgrade space program game for mobile — a static PWA, no build, no app process.

Served at **https://space.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Review timing

`.claude/rules/lab980-conventions.md` says to watch a PR on a five-minute
poll and that Codex reviews when a PR opens, when a draft is marked ready,
and when asked. This repo adds the missing case, and it is the owner's
standing instruction, not a suggestion:

- **Five quiet minutes is the answer.** After opening a PR or pushing to
  it, if five minutes pass with no Codex review, no reaction and no
  comment, treat that as "no findings" and merge. Do not re-arm another
  quiet check-in, and do not ask for a review first — a stalled bot is
  not a reason to leave a PR sitting.
- When Codex does respond, the conventions file's loop applies as written:
  verify each finding before fixing it, push, resolve, re-request with
  `@codex review` after a substantial push, then merge once it comes back
  clean. Merging is still not deploying.

## Shape

Fully **static**: the site is files served straight by nginx. No build step,
no app process, no local port, no pm2, no database. nginx serving the git
checkout *is* the deployment, so "what's on `main`" and "what's live" differ
only by a `git reset` on the droplet.

- Repo: `ivjames/space` · droplet checkout: `/var/www/space` (the web root)
- Operate CLI: `bin/space`, symlinked to `/usr/local/bin/space`
- vhost: generated from `deploy/nginx.conf.template` by `space setup`

## Deploying

On the droplet, as root:

```bash
space deploy      # git fetch + reset --hard origin/main (+ build stamp)
space status      # HEAD, live probe, cert days remaining
```

Full runbook, including first-time bring-up: `DEPLOY.md`.

Checking what is actually live, concretely for this site — `space status`
on the box, or from anywhere:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://space.lab980.com/
curl -s https://space.lab980.com/ | grep -o "const BUILD = '[^']*'" | head -1
```

(The second line reports nothing if the page carries no `BUILD` constant — see
the deploy stamp note in `DEPLOY.md`. `head -1` because a page that polls its
own build stamp carries a matching regex literal, which grep otherwise reports
as a phantom second build.)

## What is here

Not one `index.html`: the game is `index.html` + `css/` + `js/` (ES modules,
`js/core` pure logic, `js/ui` browser, `js/data` content), a PWA manifest and
service worker, `test/*.test.js` (`npm test`, Node 22, no install), a browser
smoke test (`test/e2e`, needs playwright-core), and `tools/balance.mjs` which
audits tier balance against the real resolver. `DESIGN.md` is the design;
`ARCHITECTURE.md` is the module contract. Change the contract there first.

Nothing needs `npm install` to run or deploy. `package.json` exists for the
test scripts only; keep it dependency-free (the Capacitor wrap, when it comes,
adds its own).

## Things worth knowing

- The service worker is cache-first on a cache named for the deployed
  commit. `space deploy` stamps the commit into `sw.js`'s `CACHE_NAME` as
  well as the page's `BUILD`; the browser re-fetches `sw.js` on every load
  (the vhost serves it and `index.html` `no-cache`), a changed worker
  precaches the whole app once with the HTTP cache bypassed, and the page
  shows "Update ready — tap to reload". So a deploy reaches an installed PWA
  on the first load after it, one tap away, and costs one request per load
  otherwise. Unstamped (`space-dev`) the worker is network-first, so a local
  checkout never serves stale files. The JS/CSS files carry no
  `Cache-Control` at all; that is fine only because the worker never
  revalidates through the HTTP cache — keep it that way.
- `index.html` carries `const BUILD = 'dev'`; `space deploy` stamps the commit
  into it and `space status` reads it back, next to the worker's stamp.
  `window.__BUILD` exposes it. `test/sw.test.js` pins both stamp lines to
  the exact shape the deploy `sed` matches, and the precache list to the
  module tree.
- `test/`, `tools/`, `package.json` and `ARCHITECTURE.md` are all in the web
  root. `*.md` and dotfiles are denied by the vhost; the rest is public and
  harmless.

- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). Don't commit secrets;
  there is no `.env` on a static site.
- There is no `.env` here and nothing to keep out of git beyond that — a
  static site has no secrets to hold.
