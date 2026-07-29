// Second pass over the City of Ithaca map spreadsheet: fit its whole-cemetery
// "Map" sheet, then use it to place sections the per-section sheets couldn't
// (notably 1st ADD 1, the largest, which had too few anchors of its own).
//
// Method: the per-section fits already produced real-world positions for
// thousands of lots. Where a lot number is unique on the Map sheet AND unique
// among those fitted lots, cell<->world is unambiguous — enough pairs to
// RANSAC one global transform. Cells that then land on an already-fitted lot
// are "explained"; the leftovers are the unfit sections, and a leftover whose
// number appears in an unfit section's register becomes that section's lot.
// Appends to geometry/ithaca.json. Run after build-ithaca-geometry.js.
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const CS = require(path.join(APP, 'app-core.js'));

const CID = 1775380;
const TARGETS = ['1st ADD 1'];          // sections to recover from the overview
const grid = JSON.parse(fs.readFileSync('ithaca-grid.json', 'utf8')).filter(g => g.sheet === 'Map');
const geomPath = path.join(APP, 'geometry', 'ithaca.json');
const geom = JSON.parse(fs.readFileSync(geomPath, 'utf8'));
const src = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const DS = CS.normalizeDataset(JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)));
const cem = DS.cemeteries.find(c => c.id === CID);
const model = CS.buildModel(cem.data, {});
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const applyT = (T, x, y) => ({ e: T.a * x + T.b * y + T.c, n: T.d * x + T.f * y + T.g });

/* ---------- world positions already known, from the per-section fits ---------- */
const fitted = [];                       // {section, lot, e, n}
for (const m of geom.maps) {
  if (m.file !== 'ithaca-city-cemetery-map') continue;
  for (const e of m.entries) {
    const w = applyT(m.transform, e[2], e[3]);
    fitted.push({ section: m.section, lot: String(e[1]), e: w.e, n: w.n });
  }
}
const fittedByLot = new Map();
for (const f of fitted) {
  if (!fittedByLot.has(f.lot)) fittedByLot.set(f.lot, []);
  fittedByLot.get(f.lot).push(f);
}
console.log(`known lot positions from per-section fits: ${fitted.length}`);

/* ---------- unambiguous cell <-> world pairs ---------- */
const cellCount = {};
for (const c of grid) cellCount[c.lot] = (cellCount[c.lot] || 0) + 1;
// A lot number unique on the Map sheet may still match several fitted
// sections; keep every option as a hypothesis and let RANSAC choose the
// consensus (inliers are counted one-per-cell, so only one option can win).
const pairs = [];
for (const c of grid) {
  if (cellCount[c.lot] !== 1) continue;              // repeats on the sheet
  for (const f of (fittedByLot.get(c.lot) || []))
    pairs.push({ cell: c.col + ',' + c.row, x: c.col, y: c.row, e: f.e, n: f.n, lot: c.lot, section: f.section });
}
const distinctCells = new Set(pairs.map(p => p.cell)).size;
console.log(`anchor hypotheses: ${pairs.length} across ${distinctCells} unique-on-sheet cells`);
if (distinctCells < 6) { console.log('too few cells to fit — stopping'); process.exit(1); }
// keep at most one inlier per cell (the closest option)
const bestPerCell = (T, thresh) => {
  const winner = new Map();
  for (const p of pairs) {
    const q = applyT(T, p.x, p.y);
    const d = Math.hypot(q.e - p.e, q.n - p.n);
    if (d > thresh) continue;
    const cur = winner.get(p.cell);
    if (!cur || d < cur.d) winner.set(p.cell, { p, d });
  }
  return [...winner.values()].map(w => w.p);
};

function solveAffine(ps) {
  const solve3 = (M, v) => {
    const A = M.map((r, i) => [...r, v[i]]);
    for (let i = 0; i < 3; i++) {
      let mx = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[mx][i])) mx = j;
      [A[i], A[mx]] = [A[mx], A[i]];
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let j = i + 1; j < 3; j++) {
        const f2 = A[j][i] / A[i][i];
        for (let k = i; k < 4; k++) A[j][k] -= f2 * A[i][k];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--)
      x[i] = (A[i][3] - A[i].slice(i + 1, 3).reduce((s, v2, k) => s + v2 * x[i + 1 + k], 0)) / A[i][i];
    return x;
  };
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sex = 0, Sey = 0, Se = 0, Snx = 0, Sny = 0, Sn = 0;
  for (const p of ps) {
    Sxx += p.x * p.x; Sxy += p.x * p.y; Sx += p.x; Syy += p.y * p.y; Sy += p.y;
    Sex += p.e * p.x; Sey += p.e * p.y; Se += p.e; Snx += p.n * p.x; Sny += p.n * p.y; Sn += p.n;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, ps.length]];
  const abc = solve3(M, [Sex, Sey, Se]);
  const dfg = solve3(M, [Snx, Sny, Sn]);
  return abc && dfg ? { a: abc[0], b: abc[1], c: abc[2], d: dfg[0], f: dfg[1], g: dfg[2] } : null;
}

let best = null;
for (let i = 0; i < 40000; i++) {
  const s = [];
  const cells = new Set();
  let guard = 0;
  while (s.length < 3 && guard++ < 40) {
    const p = pairs[Math.floor(Math.random() * pairs.length)];
    if (cells.has(p.cell)) continue;
    cells.add(p.cell); s.push(p);
  }
  if (s.length < 3) continue;
  const T = solveAffine(s);
  if (!T) continue;
  const sx = Math.hypot(T.a, T.d), sy = Math.hypot(T.b, T.f);
  if (sx < 0.5 || sx > 25 || sy < 0.5 || sy > 25) continue;
  const inl = bestPerCell(T, 12);
  if (!best || inl.length > best.inl.length) best = { T, inl };
}
if (!best || best.inl.length < 6) { console.log('no consensus global fit (best ' + (best ? best.inl.length : 0) + ')'); process.exit(1); }
let T = best.T, inl = best.inl;
for (let r = 0; r < 3; r++) {
  const T2 = solveAffine(inl);
  if (!T2) break;
  const inl2 = bestPerCell(T2, 10);
  if (inl2.length < 6) break;
  T = T2; inl = inl2;
}
const resid = inl.map(p => { const q = applyT(T, p.x, p.y); return Math.hypot(q.e - p.e, q.n - p.n); });
const looMedian = Math.round(med(resid) * 10) / 10;
console.log(`global Map-sheet fit: ${inl.length}/${pairs.length} inliers, residual ${looMedian} m`);
console.log('  sections represented:', [...new Set(inl.map(p => p.section))].join(', '));
if (looMedian > 15) { console.log('fit too loose — stopping'); process.exit(1); }

/* ---------- explain cells, then claim leftovers for the unfit sections ---------- */
const registerLots = {};
for (const s of TARGETS) registerLots[s] = new Set();
for (const r of model.roster) {
  if (registerLots[r.section] && r.lot) registerLots[r.section].add(String(parseInt(r.lot)));
}
const added = {};
for (const s of TARGETS) added[s] = [];
let explained = 0;
for (const c of grid) {
  const w = applyT(T, c.col, c.row);
  const same = fittedByLot.get(c.lot) || [];
  if (same.some(f => Math.hypot(f.e - w.e, f.n - w.n) < 12)) { explained++; continue; }
  for (const s of TARGETS) {
    if (!registerLots[s].has(c.lot)) continue;
    // don't place a lot where another section's lot of the same number already sits
    added[s].push(['', c.lot, c.col, c.row]);
    break;
  }
}
console.log(`cells explained by existing fits: ${explained}/${grid.length}`);
for (const s of TARGETS) {
  const list = added[s];
  if (!list.length) { console.log(`  ${s}: nothing to add`); continue; }
  const pts = list.map(e => applyT(T, e[2], e[3]));
  const spreadE = Math.max(...pts.map(p => p.e)) - Math.min(...pts.map(p => p.e));
  const spreadN = Math.max(...pts.map(p => p.n)) - Math.min(...pts.map(p => p.n));
  console.log(`  ${s}: +${list.length} lots, footprint ${spreadE.toFixed(0)}x${spreadN.toFixed(0)} m`);
  // sanity: this section's own GPS anchors should land near their new positions
  const checks = [];
  const byLot = new Map(list.map(e => [e[1], e]));
  for (const r of model.roster) {
    if (r.section !== s || !r.lot) continue;
    const g = r.fieldGps || (r.mem && r.mem.lat != null ? r.mem : null);
    if (!g) continue;
    const e = byLot.get(String(parseInt(r.lot)));
    if (!e) continue;
    const q = applyT(T, e[2], e[3]);
    const en = model.proj.toEN(g.lat, g.lng);
    checks.push(Math.hypot(q.e - en.e, q.n - en.n));
  }
  console.log(`    validation vs its own GPS anchors: ${checks.length ? checks.map(d => d.toFixed(0) + 'm').join(', ') : 'none available'}`);
  if (checks.length >= 2 && med(checks) > 25) { console.log('    REJECTED — anchors disagree'); continue; }
  geom.maps.push({
    file: 'ithaca-city-overview', section: s, sub: '', style: 'lots',
    page: { w: 0, h: 0 }, transform: T,
    quality: looMedian <= 6 ? 'good' : looMedian <= 12 ? 'fair' : 'approx',
    looMedian, entries: list,
  });
}
fs.writeFileSync(geomPath, JSON.stringify(geom));
console.log(`\nwrote geometry/ithaca.json: ${geom.maps.length} maps, ${geom.maps.reduce((s, m) => s + m.entries.length, 0)} entries`);
