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

## Reaching the app over Tailscale (why macvlan + subnet routes fails)

Symptom: on Wi-Fi everything works; on cellular the map tiles stop loading
and photos never upload (they queue instead).

A macvlan container owns a LAN IP (192.168.5.14) but is **invisible to its
own host** — that isolation is built into macvlan. Tailscale runs *on the
host*, so when it forwards a subnet-route packet for 192.168.5.14 the
packet has to leave the host's NIC and come back to the same NIC, which
macvlan filtering (and switch split-horizon) drops. Advertising
`192.168.5.0/24` therefore reaches every other LAN device **except the
container living on the router itself.**

One-line proof — run it *on the Pi*:

    curl -sk -o /dev/null -w '%{http_code}\n' https://192.168.5.14/

`000` means the host can't reach the container, so Tailscale can't either,
and no Tailscale setting will change that. (Another LAN device gets `200`.)

**Fix A — published ports (what the shipped stack does).** Drop macvlan;
publish 8420/8443 on the host. Tailscale then serves the app at the Pi's
own name from anywhere, and the LAN uses the same URL. Simple and durable.

**Fix B — keep 192.168.5.14 via a macvlan shim.** Give the host its own
macvlan sub-interface so it *can* reach the container, then subnet routing
works. On the Pi (persist it in `/etc/rc.local`, a systemd unit, or
networkd — it does not survive a reboot on its own):

    sudo ip link add shim link eth0 type macvlan mode bridge
    sudo ip addr add 192.168.5.99/32 dev shim     # any free LAN address
    sudo ip link set shim up
    sudo ip route add 192.168.5.14/32 dev shim

Re-run the curl above; it should return `200`. Also confirm the route is
advertised and approved: `tailscale up --advertise-routes=192.168.5.0/24`
plus "Use subnet routes" enabled on the phone. Fix B keeps the dedicated
IP but adds a moving part that quietly disappears on reboot — prefer A
unless the .14 address matters to you.

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
