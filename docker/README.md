# Deploying Cemetery Search with Portainer (Flask + auto-refresh)

One container does everything: serves the app on **port 80 (http) and 443
(https, self-signed for 192.168.5.14)** — **and refreshes all cemetery data
automatically** — photo requests every `REFRESH_HOURS` (default 6 h), memorial
indexes weekly, cemetery discovery daily (any nearby cemetery that gets a new
photo request is added by itself), BS&A burial registers every ~60 days.

The tarball `cemetery-search-portainer.tar.gz` here is the self-contained
deploy bundle — its `DEPLOY.md` covers the Pi steps, including the two ways
to put it on 192.168.5.14 (host port mapping vs. dedicated macvlan IP) and
the one-time browser warning for the self-signed https certificate.

## Deploy from the repository (easiest)

1. Portainer → **Stacks → Add stack → Repository**
2. Repository URL: your clone/remote of this repo; Compose path: `docker/docker-compose.yml`
3. Deploy. First boot serves the baked dataset immediately and then
   self-refreshes in the background.

Or copy the repo to the host and use **Add stack → Web editor** with the same
compose file (build context is the repo root).

## Configuration (stack environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `REFRESH_HOURS` | `6` | photo-request refresh cadence |
| `RADIUS_MILES` | `15` | auto-include cemeteries with open requests within this range |
| `PORT` | `8420` | listen port |

Wider changes (counties scanned, BS&A registers, pinned cemeteries) live in
`refresher.py` `DEFAULT_CONFIG` (repo root), or drop a `config.json` override
next to it.

Running without Docker is the same server: `pip install -r requirements.txt`
then `python app.py` from the repo root — same app, same auto-refresh.

## Endpoints

- `http://<host>/` (or https) — the app
- `/api/status` — dataset freshness, counts, last error
- `POST /api/refresh` — trigger a refresh now

## ⚠ HTTPS matters for field use

Phone **GPS, compass, and offline install (PWA) only work over HTTPS** — put the
container behind your reverse proxy with a certificate (Synology reverse proxy +
Let's Encrypt works well) and open the HTTPS hostname on the phone, then
*Add to Home Screen*. Over plain LAN HTTP the app still works as a
lookup/search tool, but live navigation is blocked by the browser.

(The GitHub Pages copy at `https://kasgore.github.io/Cemetery-Search/` is
already HTTPS whenever the repo is pushed, but its data only updates when you
commit a regenerated `cemetery-data.js` — the Portainer container updates itself.)
