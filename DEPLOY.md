# Deploying Space

Target: **https://space.lab980.com** — served from the lab980 droplet (conventions in
the `ivjames/lab980.com` repo's `CLAUDE.md`).

The site is static files with no dependencies: no build step, no app process,
no port, no pm2, no database. nginx serving the git checkout *is* the
deployment. Everything is driven by the operate CLI at `bin/space`.

> Why not `provision-site`? That script scaffolds proxy-shaped sites (an app on
> a local port). This site has no app, so `space setup` writes its own
> static vhost instead — same DNS/doctl, security-headers and certbot shape.

## One-time bring-up (on the droplet, as root)

```bash
git clone https://github.com/ivjames/space /var/www/space
ln -sf /var/www/space/bin/space /usr/local/bin/space
space setup
```

`space setup` is idempotent and does, in order:

1. **DNS** — `doctl` A record `space.lab980.com -> droplet IP` (skipped if it already
   exists; `--no-dns` to skip, `--ip` to override autodetect).
2. **nginx** — static vhost from `deploy/nginx.conf.template` installed as
   `/etc/nginx/sites-available/space.lab980.com`, symlinked into `sites-enabled/`,
   `nginx -t` + reload. Root is the checkout; `index.html` is served
   `Cache-Control: no-cache` so deploys are live on the next visit; dotfiles
   and `*.md` are denied. An existing vhost is left untouched (certbot owns it
   after TLS).
3. **TLS** — waits for DNS to resolve, then
   `certbot --nginx -d space.lab980.com --redirect -n`. If DNS is still propagating it
   prints the exact certbot command to re-run.

## Deploying updates

Land changes on `main` (via a PR — see `CLAUDE.md`), then on the droplet:

```bash
space deploy
```

That is `git fetch` + `git reset --hard origin/main` of the checkout, plus a
`sed` that stamps the deployed commit into the page's `BUILD` constant if it
has one. No build, no restart, no reload.

## Check it

```bash
space status              # HEAD commit, live probe, cert days
health-check --site space # the droplet-wide auditor also covers it
```

## Overrides

- `SPACE_FQDN` — serve under a different name (default `space.lab980.com`)
- `SPACE_BRANCH` — deploy a different branch (default `main`)
