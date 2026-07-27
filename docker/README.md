# Deploying Cemetery Search with Portainer

Files here:

- `cemetery-search-site.tar.gz` — the complete built app (regenerate by re-tarring the repo root files listed in the compose comment)
- `docker-compose.yml` — the stack (nginx serving the site on port **8420**)
- `nginx.conf` — mime types, gzip, and cache headers tuned for the PWA

## Steps

1. Copy this `docker/` directory to your Docker host (e.g. `/volume1/docker/cemetery-search/`).
2. Extract the site into a `site/` subdirectory **next to the compose file**:
   ```
   mkdir -p site && tar -xzf cemetery-search-site.tar.gz -C site
   ```
3. In Portainer: **Stacks → Add stack → Upload / paste** `docker-compose.yml`, set the stack's working directory to where you copied the files (or use a bind path that matches), and deploy.
4. Open `http://<host>:8420/` — the app should load with all data baked in.

## ⚠ HTTPS matters for field use

Phone **GPS, compass, and offline install (PWA) only work over HTTPS** — browsers block them on plain `http://`. On the LAN over HTTP the app works as a lookup/search tool, but the Guide arrow and blue-dot map won't.

To get the full field experience from your own hosting, put the container behind your reverse proxy with a certificate (Synology's built-in reverse proxy + Let's Encrypt works well), and reach it by that HTTPS hostname from the phone — then use *Add to Home Screen* to install it for offline use at the cemetery.

(The GitHub Pages copy at `https://kasgore.github.io/Cemetery-Search/` already satisfies all of this whenever the repo is pushed.)
