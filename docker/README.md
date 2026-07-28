# Deploying Cemetery Search with Portainer (Flask + auto-refresh)

## No-GitHub, UI-only deploy (image build + web-editor stack)

The web editor cannot run `build:` blocks (a pasted stack has no repo files
next to it — the "lstat /data/compose/…/docker" error). Instead:

1. **Images → Build a new image** — name `cemetery-search:latest`, **Upload**
   tab, select an image-build tarball (Dockerfile at archive root; make one
   with: `cp docker/Dockerfile Dockerfile && tar -czf build.tar.gz Dockerfile
   requirements.txt app.py refresher.py index.html cemetery-search.html
   app-*.js cemetery-data.js xlsx.full.min.js sw.js manifest.webmanifest
   icons geometry seed`), then Build.
2. **Stacks → Add stack → Web editor** — paste `docker/cemetery-search-stack.yml`
   (image-only, no build) and deploy.

Updating later = rebuild the image from a fresh tarball (same name), then
re-deploy the stack.

One container does everything: serves the app on **port 80 (http) and 443
(https, self-signed for 192.168.5.14)** — **and refreshes all cemetery data
automatically** — photo requests every `REFRESH_HOURS` (default 6 h), memorial
indexes weekly, cemetery discovery daily (any nearby cemetery that gets a new
photo request is added by itself), BS&A burial registers every ~60 days,
aerial-imagery tiles incrementally.

The tarball `docker/cemetery-search-portainer.tar.gz` is the self-contained
deploy bundle — its `DEPLOY.md` covers the Pi steps, including the two ways
to put it on 192.168.5.14 (host port mapping vs. dedicated macvlan IP) and
the one-time browser warning for the self-signed https certificate.

## Deploy from the repository

1. Portainer → **Stacks → Add stack → Repository**
2. Repository URL: your clone/remote of this repo; Compose path:
   `docker-compose.yml` (repo root — the build context must be the repo root)
3. Deploy. First boot serves the baked dataset immediately and then
   self-refreshes in the background.

Or use the tarball (see `DEPLOY.md` inside it), or copy the repo to the host
and run `docker compose up -d --build` from the repo root.

## Configuration (stack environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REFRESH_HOURS` | `6` | photo-request refresh cadence |
| `RADIUS_MILES` | `15` | auto-include cemeteries with open requests within this range |
| `CERT_HOSTS` | `192.168.5.14,localhost` | names/IPs baked into the self-signed https certificate |
| `PORT` | `8420` | internal http port — leave alone under the standard stack (host 80 maps onto it); set `80` only for macvlan |
| `HTTPS_PORT` | `8443` | internal https port — same note as PORT; set `443` only for macvlan |
| `AUTO_REFRESH` | `1` | set `0` to disable all self-updating (serve baked data only) |

Wider changes (counties scanned, BS&A registers, pinned cemeteries) live in
`refresher.py` `DEFAULT_CONFIG` (repo root), or drop a `config.json` override
next to it.

Running without Docker is the same server: `pip install -r requirements.txt`
then `python app.py` from the repo root — same app, same auto-refresh.

## Endpoints

- `http://<host>/` or `https://<host>/` — the app
- `/api/status` — dataset freshness, counts, last error
- `POST /api/refresh` — trigger a refresh now
- `/tiles/{z}/{x}/{y}.jpg` — cached aerial imagery

## HTTPS and field use

The container generates its own certificate for `CERT_HOSTS` on first boot.
Browsers can't verify a self-signed cert for a private IP, so the first
https visit shows a warning — **Advanced → Proceed, once per device**. After
that, phone **GPS, compass, and the Guide arrow work** at
`https://192.168.5.14/`.

The only feature that still needs a publicly-trusted certificate is
offline/home-screen **install** (service workers refuse self-signed). If you
want that — or reachability from the cemetery over cellular — run
**Tailscale** on the Pi and phone with `tailscale serve`, which provides a
valid HTTPS URL everywhere.
