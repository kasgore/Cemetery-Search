# Cemetery Search — Grave Finder

A field app for fulfilling Find a Grave photo requests at **Oak Grove Cemetery, St. Louis, Michigan** — built to actually locate the graves, not just list them.

**Use it here: https://kasgore.github.io/Cemetery-Search/** (install to your phone's home screen for offline use — see the app's Data tab).

## What it does

- **Predicts a GPS position for nearly every grave** by combining three data sources:
  1. the **city's official plat maps** (23 vector PDFs from stlouismi.com, one per section) — every lot-number label was extracted with its map position;
  2. **630 GPS-tagged memorials** on Find a Grave, used to georeference each plat map with a RANSAC-fitted affine transform (typical accuracy: 3–8 m, i.e. within a stone or two);
  3. the **city's public burial register** (BS&A Online) — supplies Section/Block/Lot/Grave for people whose Find a Grave memorial has no plot info at all.
- **Walking list** grouped by section in walking order, with per-grave status (photographed / no stone / not found), notes, and requester hints.
- **Guide mode**: live compass arrow + distance to the predicted spot (declination-corrected), with an accuracy circle so you know when to stop walking and start reading stones.
- **Neighbors list** for every target: who's buried in the same and adjacent lots, flagging stones already photographed on Find a Grave (📷) — walk to a photographed neighbor, then count stones. Spouses are very often in the same lot even when unmarked.
- **Offline map** of the whole cemetery rendered from the extracted plat geometry: lot grid, block letters, section names, targets, and your live position.
- **Search all ~7,600 burials offline** — memorials and the city register, cross-matched by name/dates (with nickname and spelling tolerance).
- **PWA**: installs to the home screen, works fully offline (the cemetery may have weak signal). Progress auto-saves locally; export/import backups from the Data tab.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | app shell + styles |
| `app-core.js` | data model, plot parsers, matching, geometry engine (no DOM — unit-testable) |
| `app-map.js` | canvas map renderer (map tab + guide minimap) |
| `app-ui.js` | UI, sensors (GPS/compass/wake-lock), imports, storage |
| `oakgrove-data.js` | baked dataset: photo requests, memorial index, burial register, georeferenced plat geometry |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA/offline |
| `cemetery-search.html` | old entry point → redirects to `index.html` |
| `tools/` | the data pipeline (below) |

## Refreshing data

Photo requests change often — refresh them **from inside the app** (Data tab): drop Find a Grave's official *Download List* file, or use the one-tap bookmarklet. Memorial-index refreshes (new GPS pins improve map accuracy) also have a bookmarklet. No rebuild needed.

To rebuild the baked dataset from scratch (`tools/`, run with Node 18+):

```
node tools/pull-memorials.js     # Find a Grave memorial index (paced, ~4 min)
node tools/pull-bsa.js           # city burial register from BS&A (paced, ~3 h, resumable)
node tools/extract-maps.js       # lot-label positions from the city plat PDFs (needs pdfjs-dist, maps/*.pdf)
node tools/build-geometry.js     # georeference each plat map against GPS anchors
node tools/build-appdata.js      # merge everything -> oakgrove-data.js
node tools/test-core.js          # test suite (run from a dir containing photo-requests.json)
```

Plat PDFs: https://www.stlouismi.com/government/city-clerk/cemetery/ · City Clerk: Jamie Long, (989) 681-2137 ext. 1050, jlong@stlouismi.com.

## Accuracy notes

- Positions are **predictions**: lot-level ±4–12 m for well-anchored sections (Square Hill, Round Hill, both North Hills, Hoffstetter, Old Part subs 2–4), wider for sections with few GPS anchors (Vault Hill, Veterans Hill, Oak Hill, Single Grave). The app shows the level and radius on every card.
- Grave-within-lot position (which corner is grave 1) is not derivable from public data — the clerk can confirm the convention. Stakes are one stone-width (~1 m).
- Find a Grave GPS pins are volunteer-submitted; ~10 % are junk (pinned off-site) and are filtered before use.

Other cemeteries: the app degrades gracefully without `oakgrove-data.js` — paste any photo-request export and burial roster via the Data tab (matching + walking list still work; the plat map layer is Oak Grove-specific).
