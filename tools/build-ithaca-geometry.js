// Georeference the City of Ithaca cemetery-map grid (extract-ithaca-grid.py)
// against GPS-tagged memorials, producing geometry/ithaca.json.
//
// The spreadsheet's per-sheet (column,row) is a faithful relative layout, so
// one affine transform per sheet maps grid space -> local meters. Anchors are
// FAG memorials whose parsed plot names a (section, lot) that appears exactly
// once in that sheet (ambiguous lot numbers are never used to fit). RANSAC
// picks the consensus, then a least-squares refit runs on the inliers, and
// sheets whose fit stays poor are dropped rather than shipped as guesses.
// Usage: node build-ithaca-geometry.js   (from a dir holding ithaca-grid.json)
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const CS = require(path.join(APP, 'app-core.js'));

const CID = 1775380;
const grid = JSON.parse(fs.readFileSync('ithaca-grid.json', 'utf8'));
const src = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const DS = CS.normalizeDataset(JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1)));
const cem = DS.cemeteries.find(c => c.id === CID);
const model = CS.buildModel(cem.data, {});
const cc = cem.data.meta.cem;
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* ---------- sheet name -> register section names ---------- */
// the register writes "1st ADD 1"/"1st ADD 2"; sheets covering two lettered
// sections (L & M, N & O) serve both — lot uniqueness disambiguates
const SHEET_SECTIONS = {
  'Old Plat': ['Old Plat', 'Old plat'],
  '2nd ADD': ['2nd ADD'],
  '3rd ADD': ['3rd ADD'],
  '1st ADD': ['1st ADD 1', '1st ADD'],
  '1st ADD 2nd': ['1st ADD 2'],
  'L & M': ['L', 'M'],
  'N & O': ['N', 'O'],
};

/* ---------- anchors: (section, lot) -> GPS ----------
   Two sources, because Ithaca's memorials rarely carry plot strings: the
   memorial's own parsed plot, and — the big one — a register row (which
   always has section+lot) whose name-matched memorial carries GPS. */
const anchorsByKey = new Map();
const addAnchor = (section, lot, en) => {
  const key = section + '|' + String(parseInt(lot));
  if (!anchorsByKey.has(key)) anchorsByKey.set(key, []);
  anchorsByKey.get(key).push(en);
};
const inBounds = (lat, lng) => {
  const d = CS.distM(lat, lng, cc.lat, cc.lng);
  return isFinite(d) && d >= 5 && d <= 800;
};
let fromMem = 0, fromReg = 0;
for (const m of model.memorials) {
  if (m.lat == null || !m.p || !m.p.section || !m.p.lot) continue;
  if (!inBounds(m.lat, m.lng)) continue;
  addAnchor(m.p.section, m.p.lot, model.proj.toEN(m.lat, m.lng));
  fromMem++;
}
for (const r of model.roster) {
  const g = r.fieldGps || (r.mem && r.mem.lat != null ? r.mem : null);
  if (!g || !r.section || !r.lot) continue;
  if (!inBounds(g.lat, g.lng)) continue;
  addAnchor(r.section, r.lot, model.proj.toEN(g.lat, g.lng));
  fromReg++;
}
console.log(`anchors: ${fromMem} from memorial plots + ${fromReg} from register x GPS = ${anchorsByKey.size} distinct (section,lot) keys`);

function solveAffine(pairs) {
  // grid (x=col, y=row) -> meters (e, n)
  const solve3 = (M, v) => {
    const A = M.map((r, i) => [...r, v[i]]);
    for (let i = 0; i < 3; i++) {
      let mx = i;
      for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[mx][i])) mx = j;
      [A[i], A[mx]] = [A[mx], A[i]];
      if (Math.abs(A[i][i]) < 1e-12) return null;
      for (let j = i + 1; j < 3; j++) {
        const f = A[j][i] / A[i][i];
        for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k];
      }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--)
      x[i] = (A[i][3] - A[i].slice(i + 1, 3).reduce((s, v2, k) => s + v2 * x[i + 1 + k], 0)) / A[i][i];
    return x;
  };
  let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0;
  let Sex = 0, Sey = 0, Se = 0, Snx = 0, Sny = 0, Sn = 0;
  for (const p of pairs) {
    const { x, y, e, n } = p;
    Sxx += x * x; Sxy += x * y; Sx += x; Syy += y * y; Sy += y;
    Sex += e * x; Sey += e * y; Se += e; Snx += n * x; Sny += n * y; Sn += n;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, pairs.length]];
  const abc = solve3(M, [Sex, Sey, Se]);
  const dfg = solve3(M, [Snx, Sny, Sn]);
  return abc && dfg ? { a: abc[0], b: abc[1], c: abc[2], d: dfg[0], f: dfg[1], g: dfg[2] } : null;
}
const applyT = (T, x, y) => ({ e: T.a * x + T.b * y + T.c, n: T.d * x + T.f * y + T.g });

const maps = [];
const report = [];
for (const [sheet, sections] of Object.entries(SHEET_SECTIONS)) {
  const cells = grid.filter(g => g.sheet === sheet);
  if (!cells.length) continue;
  // lot -> cells; only lots appearing once in the sheet can anchor
  const byLot = new Map();
  for (const c of cells) {
    if (!byLot.has(c.lot)) byLot.set(c.lot, []);
    byLot.get(c.lot).push(c);
  }
  const pairs = [];
  for (const [lot, cs] of byLot) {
    if (cs.length !== 1) continue;
    for (const sec of sections) {
      const pts = anchorsByKey.get(sec + '|' + lot);
      if (!pts || !pts.length) continue;
      const e = pts.reduce((s, p) => s + p.e, 0) / pts.length;
      const n = pts.reduce((s, p) => s + p.n, 0) / pts.length;
      pairs.push({ x: cs[0].col, y: cs[0].row, e, n, lot, sec });
    }
  }
  if (pairs.length < 4) { report.push(`${sheet}: only ${pairs.length} anchors — skipped`); continue; }

  // RANSAC over anchor triples
  let best = null;
  const iters = Math.min(4000, pairs.length * pairs.length * 3);
  for (let i = 0; i < iters; i++) {
    const s = [];
    while (s.length < 3) {
      const p = pairs[Math.floor(Math.random() * pairs.length)];
      if (!s.includes(p)) s.push(p);
    }
    const T = solveAffine(s);
    if (!T) continue;
    const sx = Math.hypot(T.a, T.d), sy = Math.hypot(T.b, T.f);
    if (sx < 0.2 || sx > 20 || sy < 0.2 || sy > 20) continue;   // grid steps are metres-per-cell
    const inl = pairs.filter(p => {
      const q = applyT(T, p.x, p.y);
      return Math.hypot(q.e - p.e, q.n - p.n) < 18;
    });
    if (!best || inl.length > best.inl.length) best = { T, inl };
  }
  if (!best || best.inl.length < 4) { report.push(`${sheet}: no consensus fit (${pairs.length} anchors)`); continue; }
  let T = best.T, inl = best.inl;
  for (let r = 0; r < 3; r++) {
    const T2 = solveAffine(inl);
    if (!T2) break;
    const inl2 = pairs.filter(p => {
      const q = applyT(T2, p.x, p.y);
      return Math.hypot(q.e - p.e, q.n - p.n) < 15;
    });
    if (inl2.length < 4) break;
    T = T2; inl = inl2;
  }
  const resid = inl.map(p => {
    const q = applyT(T, p.x, p.y);
    return Math.hypot(q.e - p.e, q.n - p.n);
  });
  const looMedian = Math.round(med(resid) * 10) / 10;
  if (looMedian > 20) { report.push(`${sheet}: fit too loose (${looMedian} m) — dropped`); continue; }

  // emit every cell of this sheet, one map per register section it serves
  for (const sec of sections) {
    const entries = [];
    for (const [lot, cs] of byLot) {
      if (cs.length !== 1) continue;    // ambiguous within the sheet — skip
      entries.push(['', lot, cs[0].col, cs[0].row]);
    }
    if (!entries.length) continue;
    maps.push({
      file: 'ithaca-city-cemetery-map', section: sec, sub: '', style: 'lots',
      page: { w: 0, h: 0 },
      transform: T,
      quality: looMedian <= 6 ? 'good' : looMedian <= 12 ? 'fair' : 'approx',
      looMedian, entries,
    });
  }
  report.push(`${sheet}: ${inl.length}/${pairs.length} anchors inlier, residual ${looMedian} m, ${byLot.size} lots -> sections ${sections.join('+')}`);
}

report.forEach(r => console.log('  ' + r));
if (!maps.length) { console.log('no sheets fit — nothing written'); process.exit(1); }
const geom = { sections: {}, maps, declination: cem.data.meta.declination };
fs.writeFileSync(path.join(APP, 'geometry', 'ithaca.json'), JSON.stringify(geom));
console.log(`\nwrote geometry/ithaca.json: ${maps.length} section maps, ${maps.reduce((s, m) => s + m.entries.length, 0)} lot entries`);
