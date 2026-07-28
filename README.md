# Cemetery Search — Grave Finder

A field app for fulfilling Find a Grave photo requests at **38 cemeteries around St. Louis, Michigan** — built to actually locate the graves, not just list them, and to keep itself up to date automatically.

**Two ways to run it:**
- **Self-hosted (recommended):** the Flask container in `docker/` serves the app *and refreshes all data on a schedule* — photo requests every 6 h, memorial indexes weekly, cemetery discovery daily (a new request anywhere nearby auto-adds that cemetery), municipal burial registers every ~60 days. See `docker/README.md` for the Portainer stack.
- **Portainer repository deploys** use the root `docker-compose.yml` (build context = repo root).
- **Static:** GitHub Pages (https://kasgore.github.io/Cemetery-Search/) serves the last committed dataset; refresh via the in-app bookmarklets/imports.

## What it does

- **Locates graves by the best available evidence**, per request:
  1. the memorial's own GPS pin;
  2. **lot positions from georeferenced city plat maps** (Oak Grove: 23 vector PDFs from the city, fitted with RANSAC against 450+ GPS-tagged memorials — 3–8 m typical; Riverside/Alma: the city's one-page plat via interment.net, cluster-fingerprint fit — 808 positions across 10 blocks incl. the mausoleum crypt grid and grave-numbered blocks R/T, ~3–15 m);
  3. **GPS-anchor clustering**: any cemetery's GPS-tagged memorials, grouped by parsed plot (same lot → ±6–18 m depending on how many pins agree; adjacent lot, block, section fall-backs with honest radii);
  4. **burial registers for 12 cemeteries (~28.7k rows)** — BS&A Online (Oak Grove uid 2024, Riverside uid 1205), interment.net (Ithaca city register, 4,968 rows), Gratiot County Cemeteries Online via the migenweb mirror (Pritchard, Riverdale, Elm Hall, French Seville, St. Patricks-Irishtown, Brady, Sibley — 4,236 rows with section-row-position or lot-grave codes), the Chippewa Twp 1941 sexton book (305 rows, era-gated name matching), and the Lee Twp walk-order transcription (585 rows → 98% navigable, the app's best) — matched to memorials by name+dates with nickname/spelling tolerance;
  5. **register × GPS cross-anchors**: a register row matched to a GPS-photographed memorial anchors its whole row/lot, so register-only cemeteries become navigable; **field-saved GPS fixes** (Guide → Save GPS) feed the same anchor index, so every stone you confirm sharpens the map for its neighbors;
  6. **family leads** when nothing else exists: same-surname burials with locatable graves (spouses usually share the lot).
- **Walking list** across all cemeteries (nearest first, drive links) or per cemetery grouped by section, with per-grave status (photographed / no stone / not found), notes, requester hints, and **neighbor packs** (adjacent burials, 📷 = photographed stone to use as a visual anchor).
- **Guide mode**: declination-corrected compass arrow + live distance (feet/miles) + honest accuracy circle; offline canvas map with cemetery boundaries, internal drives and gates (OpenStreetMap), lot grids, block letters, sections, GPS-tagged graves with surnames at close zoom (solid dot = photographed stone), collision-culled labels with halos, a feet scale bar, and your blue dot.
- **Offline field pack**: cemeteries have weak cell signal — the Data tab pre-downloads a cemetery's aerial imagery over Wi-Fi into the device cache (tiles are cache-first and never refetched), so the full map works with zero signal.
- **Offline search of ~72,000 burials** — memorials + registers, cross-matched.
- **PWA**: installs to the home screen, fully offline in the field (HTTPS required for GPS/compass — see docker/README.md).

## Architecture

Everything runs through one webserver — **`python app.py` from this directory** serves the app at http://localhost:8420/ and auto-refreshes data, identically on a laptop or in the Portainer container.

| Piece | Purpose |
| --- | --- |
| `app.py` | **the Flask webserver** (serves the app, /api/status, background refresh thread) |
| `refresher.py` | discovery, pulls, register scrapes, dataset builds |
| `index.html`, `app-core.js`, `app-map.js`, `app-ui.js` | the app (core is DOM-free and unit-tested) |
| `cemetery-data.js` | generated dataset: all cemeteries' requests, memorial indexes, registers, plat geometry |
| `geometry/oakgrove.json`, `geometry/riverside.json`, `seed/` | static plat geometry (from `tools/`) + register seeds baked into first boot |
| `docker/` | Portainer stack (Dockerfile + compose + deploy tarball) |
| `tools/` | one-time pipeline: plat-PDF extraction, RANSAC georeferencing, test suite |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA/offline |

Refresher config lives in `refresher.py` (`DEFAULT_CONFIG`) or a `config.json` override next to it: home point, radius (default 15 mi), counties scanned, pinned cemeteries, BS&A registers. Local run: `pip install -r requirements.txt`, then `python app.py`.

## Tests

```
node tools/test-core.js     # 109 unit/integration tests (run from a dir containing photo-requests.json)
```

plus a jsdom UI harness (boot, walk, guide, imports) used during development.

## Data notes

- Find a Grave data comes from the same JSON endpoints the site's own pages use, pulled politely (paced, one-time per cadence) for personal volunteer use; per-request refreshes use FAG's official Download List export or same-origin bookmarklets.
- BS&A registers are public municipal records (sessionless deep links). Ithaca, the Gratiot townships, Coe/Pine River (Ridgelawn, Salt River) have **no** public BS&A cemetery module — checked exhaustively.
- Oak Grove specifics: city plat maps at stlouismi.com; section-code table (13 = Cutler Hill!); code 25 = unknown-plot bucket. City Clerk: Jamie Long, (989) 681-2137 ext. 1050.
