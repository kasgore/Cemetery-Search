// Synthesize row-line geometry for walk-order register cemeteries.
// Premise: these registers record section-row-position in physical walk
// order, and cemetery rows are straight lines — so positions along a row
// are linear in space. Register rows matched to GPS-tagged memorials give
// anchored (position -> lat/lng) samples; a least-squares line per row then
// places EVERY registered burial in that row, bounded to the anchored span
// (plus a short extension) so extrapolation stays honest.
// Output: geometry/walkrows-<cid>.json in the standard plat-map schema
// (identity transform — entries are already local meters), so rendering and
// locate need no new code paths.
// Usage: node tools/build-walk-rows.js   (run after registers are baked)
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const CS = require(path.join(APP, 'app-core.js'));

const CEMS = [1434, 445, 2357025, 159825, 159973];   // Pritchard, Elm Hall, St. Patricks, Chippewa, Lee
const src = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const DS = CS.normalizeDataset(JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)));
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

for (const cid of CEMS) {
  const cem = DS.cemeteries.find(c => c.id === cid);
  if (!cem || !cem.data.roster.length) { console.log(cid, ': no roster'); continue; }
  const model = CS.buildModel(cem.data, {});

  // anchors: register rows whose matched memorial carries GPS
  const rows = new Map();   // "section|row" -> {section, row, anchors:[{pos,e,n}], members:Set(pos)}
  for (const r of model.roster) {
    const pos = parseInt(r.lot);
    if (!r.section || !r.block || !isFinite(pos)) continue;
    const k = r.section + '|' + r.block;
    if (!rows.has(k)) rows.set(k, { section: r.section, row: r.block, anchors: [], members: new Set() });
    const R = rows.get(k);
    R.members.add(pos);
    if (r.mem && r.mem.lat != null) {
      const en = model.proj.toEN(r.mem.lat, r.mem.lng);
      R.anchors.push({ pos, e: en.e, n: en.n });
    }
  }

  const bySection = new Map();
  const resids = [];
  let placed = 0, rowsFit = 0;
  for (const R of rows.values()) {
    const uniq = new Map();
    for (const a of R.anchors) {
      // several anchored stones can share a pos (family stone) — average them
      if (!uniq.has(a.pos)) uniq.set(a.pos, []);
      uniq.get(a.pos).push(a);
    }
    const pts = [...uniq.entries()].map(([pos, list]) => ({
      pos,
      e: list.reduce((s, x) => s + x.e, 0) / list.length,
      n: list.reduce((s, x) => s + x.n, 0) / list.length,
    }));
    if (pts.length < 2) continue;
    // least squares e(pos), n(pos)
    const N = pts.length;
    const sp = pts.reduce((s, p) => s + p.pos, 0), spp = pts.reduce((s, p) => s + p.pos * p.pos, 0);
    const den = N * spp - sp * sp;
    if (!den) continue;
    const fit = key => {
      const sv = pts.reduce((s, p) => s + p[key], 0), spv = pts.reduce((s, p) => s + p.pos * p[key], 0);
      const slope = (N * spv - sp * sv) / den;
      return { slope, icept: (sv - slope * sp) / N };
    };
    const fe = fit('e'), fn = fit('n');
    const step = Math.hypot(fe.slope, fn.slope);
    if (step < 0.5 || step > 5) continue;   // graves are 2-12 ft apart along a row — else the "row" isn't a line
    const rowResid = pts.map(p => Math.hypot(fe.icept + fe.slope * p.pos - p.e, fn.icept + fn.slope * p.pos - p.n));
    if (pts.length >= 3 && med(rowResid) > 8) continue;   // anchors disagree with a straight line — skip the row
    resids.push(...rowResid);
    rowsFit++;
    // place members within the anchored span, extended a few positions
    const aMin = Math.min(...pts.map(p => p.pos)), aMax = Math.max(...pts.map(p => p.pos));
    const ext = Math.min(6, Math.max(2, aMax - aMin));
    if (!bySection.has(R.section)) bySection.set(R.section, []);
    const entries = bySection.get(R.section);
    for (const pos of [...R.members].sort((a, b) => a - b)) {
      if (pos < aMin - ext || pos > aMax + ext) continue;
      entries.push([R.row, String(pos),
        Math.round((fe.icept + fe.slope * pos) * 100) / 100,
        Math.round((fn.icept + fn.slope * pos) * 100) / 100]);
      placed++;
    }
  }
  if (!placed) { console.log(`${cem.name}: no fittable rows`); continue; }

  const looMedian = Math.round((resids.length ? med(resids) : 6) * 10) / 10;
  const quality = looMedian <= 4 ? 'fair' : 'approx';
  const geom = {
    sections: {},
    maps: [...bySection.entries()].map(([section, entries]) => ({
      file: 'walk-order-rows', section, sub: '', style: 'rows',
      page: { w: 0, h: 0 },
      transform: { a: 1, b: 0, c: 0, d: 0, f: 1, g: 0 },   // entries are local meters already
      quality, looMedian, entries,
    })),
    declination: cem.data.meta.declination,
  };
  const out = path.join(APP, 'geometry', `walkrows-${cid}.json`);
  fs.writeFileSync(out, JSON.stringify(geom));
  console.log(`${cem.name}: ${rowsFit} rows fit, ${placed} burials placed, anchor residual median ${looMedian} m -> ${path.basename(out)}`);
}
