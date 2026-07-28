// Pull cemetery grounds from OpenStreetMap via the Overpass API:
// boundary polygons (landuse=cemetery / amenity=grave_yard), internal
// drives (service/track/footway/path ways), and gates/entrances.
// Output: geometry/osm-grounds.json  { "<cemId>": { bounds, drives, gates } }
// bounds/drives = arrays of [lat,lng] polylines (6dp), gates = [lat,lng].
// Data © OpenStreetMap contributors, ODbL — the map credits it on-canvas.
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'cemetery-search-tool/1.0 (grave-finding volunteer app; andykasdorf@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rd = x => Math.round(x * 1e6) / 1e6;

const src = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const DATA = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));

function queryFor(lat, lng) {
  return `[out:json][timeout:45];
(
  way(around:420,${lat},${lng})["landuse"="cemetery"];
  way(around:420,${lat},${lng})["amenity"="grave_yard"];
  way(around:420,${lat},${lng})["highway"~"^(service|track|footway|path)$"];
  node(around:420,${lat},${lng})["barrier"="gate"];
  node(around:420,${lat},${lng})["entrance"];
);
out geom;`;
}

const inPoly = (lat, lng, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((xi > lng) !== (xj > lng) && lat < (yj - yi) * (lng - xi) / (xj - xi) + yi) inside = !inside;
  }
  return inside;
};
const nearAny = (lat, lng, polys, degPad) =>
  polys.some(poly => inPoly(lat, lng, poly) ||
    poly.some(([y, x]) => Math.abs(y - lat) < degPad && Math.abs(x - lng) < degPad));

(async () => {
  // merge-and-resume: keep whatever an earlier run already fetched and only
  // query cemeteries with no entry yet (Overpass rate limits make full
  // re-runs wasteful)
  const outPathPre = path.join(APP, 'geometry', 'osm-grounds.json');
  const out = fs.existsSync(outPathPre) ? JSON.parse(fs.readFileSync(outPathPre, 'utf8')) : {};
  let done = 0;
  for (const cem of DATA.cemeteries) {
    const cid = String(cem.id);
    if (out[cid]) { done++; continue; }
    let json = null;
    for (let attempt = 0; attempt < 3 && !json; attempt++) {
      try {
        const res = await fetch(OVERPASS, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(queryFor(cem.lat, cem.lng)),
        });
        if (res.status === 429 || res.status === 504) { await sleep(15000); continue; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        json = await res.json();
      } catch (e) {
        console.log(`${cem.name}: attempt ${attempt + 1} failed (${e.message})`);
        await sleep(8000);
      }
    }
    if (!json) { console.log(`${cem.name}: SKIPPED`); continue; }

    const bounds = [], driveCands = [], gates = [];
    for (const el of json.elements || []) {
      if (el.type === 'way' && el.geometry) {
        const pts = el.geometry.map(g => [rd(g.lat), rd(g.lon)]);
        const t = el.tags || {};
        if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') bounds.push(pts);
        else if (t.highway) driveCands.push(pts);
      } else if (el.type === 'node' && (el.tags || {})) {
        gates.push([rd(el.lat), rd(el.lon)]);
      }
    }
    // keep only drives that actually touch the grounds (inside the boundary,
    // or within ~60 m of it / of the centroid when OSM has no polygon)
    const pad = 0.0006; // ~60 m in degrees at this latitude
    const drives = driveCands.filter(pts => {
      const ref = bounds.length ? bounds : [[[cem.lat, cem.lng]]];
      const touching = pts.filter(([la, ln]) => nearAny(la, ln, ref, pad)).length;
      return touching >= Math.max(2, pts.length * 0.4);
    });
    const keptGates = gates.filter(([la, ln]) =>
      bounds.length ? nearAny(la, ln, bounds, pad) : Math.abs(la - cem.lat) + Math.abs(ln - cem.lng) < 0.004);

    if (bounds.length || drives.length || keptGates.length) {
      out[cid] = { bounds, drives, gates: keptGates };
      console.log(`${cem.name}: ${bounds.length} boundary, ${drives.length} drives, ${keptGates.length} gates`);
    } else {
      console.log(`${cem.name}: nothing in OSM`);
    }
    done++;
    await sleep(1200);
  }
  const outPath = path.join(APP, 'geometry', 'osm-grounds.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`\nwrote geometry/osm-grounds.json: ${Object.keys(out).length}/${done} cemeteries, ${kb} KB`);
})();
