// Riverside georeferencing, take 4: global similarity RANSAC (as take 3),
// then conservative cluster->block assignment scored against each block's
// pin cloud, with ambiguity veto; final affine refit on lot-level pairs.
const fs = require('fs');
const path = require('path');
const APP = 'C:\\Users\\Andy\\Desktop\\Coding Projects\\Cemetery Search';
const CS = require(path.join(APP, 'app-core.js'));

const texts = JSON.parse(fs.readFileSync('riverside-texts.json', 'utf8'));
const mem = JSON.parse(fs.readFileSync(path.join(APP, 'data/cem/1506-memorials.json'), 'utf8'));
const roster = JSON.parse(fs.readFileSync(path.join(APP, 'seed/roster-1506.json'), 'utf8'));
const cdjs = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const cem = JSON.parse(cdjs.slice(cdjs.indexOf('{'), cdjs.lastIndexOf('}') + 1)).cemeteries.find(c => c.id === 1506);

const R = 6371000, M_LAT = Math.PI / 180 * R, M_LNG = M_LAT * Math.cos(cem.lat * Math.PI / 180);
const toEN = (lat, lng) => ({ e: (lng - cem.lng) * M_LNG, n: (lat - cem.lat) * M_LAT });
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* ---------- pins ---------- */
const pins = [];
for (const r of mem) {
  const [, , , , , plot, lat, lng] = r;
  if (lat == null || !plot) continue;
  const p = CS.parsePlot(plot, 'generic');
  if (!p || !p.block) continue;
  const d = CS.distM(lat, lng, cem.lat, cem.lng);
  if (d < 5 || d > 800) continue;
  pins.push({ block: p.block, lot: /^\d+$/.test(p.lot || '') ? parseInt(p.lot) : null, ...toEN(lat, lng) });
}
const pinsBy = {};
for (const p of pins) (pinsBy[p.block] = pinsBy[p.block] || []).push(p);
const centroids = {};
for (const [b, ps] of Object.entries(pinsBy)) {
  if (ps.length < 3) continue;
  const me = med(ps.map(p => p.e)), mn = med(ps.map(p => p.n));
  const kept = ps.filter(p => Math.hypot(p.e - me, p.n - mn) < 60);
  if (kept.length < 3) continue;
  centroids[b] = {
    e: kept.reduce((s, p) => s + p.e, 0) / kept.length,
    n: kept.reduce((s, p) => s + p.n, 0) / kept.length,
    count: kept.length, cloud: kept,
  };
}
console.log('anchored blocks:', Object.keys(centroids).map(b => b + '(' + centroids[b].count + ')').sort().join(' '));

/* ---------- domains ---------- */
const domain = {}, isLotBlock = {};
{
  const lots = {}, graves = {};
  for (const row of roster) {
    const b = String(row[8] || '').trim();
    if (!b) continue;
    const ln = parseInt(row[9]); if (isFinite(ln)) (lots[b] = lots[b] || new Set()).add(ln);
    const gn = parseInt(row[10]); if (isFinite(gn)) (graves[b] = graves[b] || new Set()).add(gn);
  }
  for (const b of new Set([...Object.keys(lots), ...Object.keys(graves)])) {
    const L = lots[b] || new Set(), G = graves[b] || new Set();
    if (L.size >= 10) { domain[b] = L; isLotBlock[b] = true; }
    else if (G.size >= 10) { domain[b] = G; isLotBlock[b] = false; }
  }
}

/* ---------- clusters ---------- */
const numItems = texts.items.filter(it => /^\d{1,4}(\.5)?$/.test(it.s) && it.fh >= 0.4 && it.fh <= 2.5);
const RADIUS = 10;
const par = numItems.map((_, i) => i);
const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
for (let i = 0; i < numItems.length; i++)
  for (let j = i + 1; j < numItems.length; j++) {
    const a = numItems[i], b = numItems[j];
    if (Math.abs(a.x - b.x) < RADIUS && Math.abs(a.y - b.y) < RADIUS &&
        Math.hypot(a.x - b.x, a.y - b.y) < RADIUS) { const A = find(i), B = find(j); if (A !== B) par[A] = B; }
  }
const cmap = {};
numItems.forEach((it, i) => { (cmap[find(i)] = cmap[find(i)] || []).push(it); });
const clusters = Object.values(cmap).filter(c => c.length >= 5).map((c, idx) => {
  const ns = c.map(it => parseInt(it.s));
  return {
    id: idx, items: c, ns, size: c.length, max: Math.max(...ns),
    cx: c.reduce((s, it) => s + it.x, 0) / c.length,
    cy: c.reduce((s, it) => s + it.y, 0) / c.length,
  };
});
console.log('clusters >=5:', clusters.length);
const compat = (cl, b) => cl.ns.filter(n => domain[b].has(n)).length / cl.ns.length;

/* ---------- seeds & global RANSAC (same recipe as take 3) ---------- */
const seeds = [];
for (const cl of clusters) {
  if (cl.size < 25) continue;
  for (const b of Object.keys(domain)) {
    if (!centroids[b]) continue;
    const cp = compat(cl, b);
    if (cp < 0.75) continue;
    const ds = domain[b].size, dmax = Math.max(...domain[b]);
    if (cl.size > ds * 1.3) continue;
    if (cl.max < dmax * 0.35) continue;
    seeds.push({ cl, b, c: centroids[b], cp });
  }
}
function solveSim(pairs, refl) {
  let Sx = 0, Sy = 0, Se = 0, Sn = 0, N = pairs.length;
  for (const p of pairs) { Sx += p.cl.cx; Sy += refl ? -p.cl.cy : p.cl.cy; Se += p.c.e; Sn += p.c.n; }
  const mx = Sx / N, my = Sy / N, me = Se / N, mn = Sn / N;
  let a = 0, b = 0, den = 0;
  for (const p of pairs) {
    const x = p.cl.cx - mx, y = (refl ? -p.cl.cy : p.cl.cy) - my;
    const e = p.c.e - me, n = p.c.n - mn;
    a += x * e + y * n; b += x * n - y * e; den += x * x + y * y;
  }
  if (den < 1e-9) return null;
  const sc = a / den, ss = b / den;
  if (Math.hypot(sc, ss) < 0.1 || Math.hypot(sc, ss) > 3) return null;
  const yy = refl ? -1 : 1;
  return { a: sc, b: -ss * yy, c: me - sc * mx + ss * my, d: ss, f: sc * yy, g: mn - ss * mx - sc * my };
}
const applyT = (T, x, y) => ({ e: T.a * x + T.b * y + T.c, n: T.d * x + T.f * y + T.g });
const cvals = Object.values(centroids);
const spanEN = Math.hypot(
  Math.max(...cvals.map(c => c.e)) - Math.min(...cvals.map(c => c.e)),
  Math.max(...cvals.map(c => c.n)) - Math.min(...cvals.map(c => c.n)));
const bigCl = clusters.filter(c => c.size >= 25);
const spanPT = Math.hypot(
  Math.max(...bigCl.map(c => c.cx)) - Math.min(...bigCl.map(c => c.cx)),
  Math.max(...bigCl.map(c => c.cy)) - Math.min(...bigCl.map(c => c.cy)));
const scale0 = spanEN / spanPT;
const TH = 40;
function scoreT(T) {
  const bestBy = {};
  for (const s of seeds) {
    const p = applyT(T, s.cl.cx, s.cl.cy);
    const d = Math.hypot(p.e - s.c.e, p.n - s.c.n);
    if (d > TH) continue;
    if (!bestBy[s.cl.id] || d < bestBy[s.cl.id].d) bestBy[s.cl.id] = { s, d };
  }
  const inl = Object.values(bestBy).map(x => x.s);
  return { inl, nBlocks: new Set(inl.map(s => s.b)).size, score: inl.reduce((t, s) => t + s.cl.size, 0) };
}
let best = null;
for (let i = 0; i < seeds.length; i++)
  for (let j = i + 1; j < seeds.length; j++)
    for (let k = j + 1; k < seeds.length; k++) {
      const tri = [seeds[i], seeds[j], seeds[k]];
      if (new Set(tri.map(s => s.b)).size < 3 || new Set(tri.map(s => s.cl.id)).size < 3) continue;
      for (const refl of [false]) {          // streets prove: north-up, no mirror
        const T = solveSim(tri, refl);
        if (!T) continue;
        const sc = Math.hypot(T.a, T.d);
        if (sc < scale0 * 0.55 || sc > scale0 * 1.8) continue;
        if (Math.abs(Math.atan2(T.d, T.a)) > 12 * Math.PI / 180) continue;
        const r = scoreT(T);
        if (r.nBlocks < 5) continue;
        if (!best || r.score > best.score) best = { T, refl, ...r };
      }
    }
if (!best) { console.log('NO FIT'); process.exit(1); }
for (let r = 0; r < 3; r++) {
  const T = solveSim(best.inl, best.refl);
  if (!T) break;
  best = { T, refl: best.refl, ...scoreT(T) };
}
let T = best.T;
console.log('global fit: refl', best.refl, '| big clusters', best.inl.length, '| blocks', best.nBlocks,
  '| scale', Math.hypot(T.a, T.d).toFixed(3), 'm/pt');

/* ---------- assignment against pin clouds, with ambiguity veto ---------- */
function assignClusters(T) {
  const assign = new Map();
  for (const cl of clusters) {
    const scores = [];
    for (const [b, c] of Object.entries(centroids)) {
      if (!domain[b]) continue;
      const cp = compat(cl, b);
      if (cp < 0.7) continue;
      // median over labels of distance to nearest pin of b
      const ds = cl.items.map(it => {
        const p = applyT(T, it.x, it.y);
        let bd = 1e9;
        for (const q of c.cloud) bd = Math.min(bd, Math.hypot(p.e - q.e, p.n - q.n));
        return bd;
      });
      const mdist = med(ds);
      if (mdist > 55) continue;
      scores.push({ b, s: cp * Math.exp(-(mdist * mdist) / (2 * 22 * 22)), mdist });
    }
    if (!scores.length) continue;
    scores.sort((a, b) => b.s - a.s);
    // ambiguity veto: runner-up nearly as good -> refuse to guess
    if (scores.length > 1 && scores[1].s > scores[0].s * 0.55) continue;
    if (scores[0].mdist > 40) continue;
    assign.set(cl.id, scores[0].b);
  }
  return assign;
}
let assign = assignClusters(T);
console.log('assigned clusters (pass 1):', assign.size, 'of', clusters.length);

/* ---------- refit on lot-level pairs + reassign ---------- */
function lotPairs(assign) {
  const pairs = [];
  const em = {};
  for (const cl of clusters) {
    const b = assign.get(cl.id);
    if (!b) continue;
    for (const it of cl.items) {
      const n = parseInt(it.s);
      if (!domain[b].has(n)) continue;
      (em[b + '|' + n] = em[b + '|' + n] || []).push(it);
    }
  }
  for (const p of pins) {
    if (p.lot == null) continue;
    const its = em[p.block + '|' + p.lot];
    if (!its || its.length !== 1) continue;
    pairs.push({ cl: { cx: its[0].x, cy: its[0].y }, c: { e: p.e, n: p.n } });
  }
  return pairs;
}
const lp = lotPairs(assign);
console.log('lot-level refit pairs:', lp.length);
if (lp.length >= 6) {
  // refit similarity on lot pairs + block centroid pairs (weight lot pairs 3x)
  const cpairs = [];
  for (const s of best.inl) cpairs.push(s);
  const all = [...lp, ...lp, ...lp, ...cpairs];
  let T2 = solveSim(all, best.refl);
  if (T2 && Math.abs(Math.atan2(T2.d, T2.a)) > 12 * Math.PI / 180) T2 = null;
  if (T2) {
    T = T2;
    assign = assignClusters(T);
    console.log('assigned clusters (pass 2):', assign.size, '| scale', Math.hypot(T.a, T.d).toFixed(3));
  }
}

/* ---------- fingerprint-unique pass: blocks without GPS pins ---------- */
// A cluster whose numbers fit exactly one block's domain (and nearly no other's)
// is identified by arithmetic alone; its position is trusted to the global fit.
let uniqAdds = 0;
for (const cl of clusters) {
  if (assign.has(cl.id)) continue;
  const scored = [];
  for (const b of Object.keys(domain)) {
    const cp = compat(cl, b);
    if (cp < 0.8) continue;
    if (centroids[b]) {
      // pin-anchored blocks must also be geometrically plausible — a far-away
      // pin cloud disqualifies the block even when the numbers fit (this is
      // what lets MAUSO beat R for the crypt grid: R's graves 1-368 contain
      // 1-296 too, but R's pins are elsewhere)
      const ds = cl.items.map(it => {
        const p = applyT(T, it.x, it.y);
        let bd = 1e9;
        for (const q of centroids[b].cloud) bd = Math.min(bd, Math.hypot(p.e - q.e, p.n - q.n));
        return bd;
      });
      if (med(ds) > 55) continue;
    }
    scored.push({ b, cp });
  }
  scored.sort((a, b) => b.cp - a.cp);
  if (!scored.length || scored[0].cp < 0.8) continue;
  if (scored.length > 1 && scored[1].cp > 0.4) continue;   // not unique enough
  // must land inside the cemetery under the global fit
  const p = applyT(T, cl.cx, cl.cy);
  if (Math.hypot(p.e, p.n) > 500) continue;
  assign.set(cl.id, scored[0].b);
  uniqAdds++;
}
console.log('fingerprint-unique additions:', uniqAdds,
  '->', [...new Set([...assign.values()])].sort().join(' '));

/* ---------- entries (lot blocks AND grave-numbered blocks) ---------- */
// Grave-numbered blocks (R, MAUSO, ...) key entries by grave number; the app
// swaps grave->lot for blocks listed in sgBlocks so lookups still match.
const entries = [];
for (const cl of clusters) {
  const b = assign.get(cl.id);
  if (!b) continue;
  for (const it of cl.items) {
    const n = parseInt(it.s);
    if (!domain[b].has(n)) continue;
    entries.push([b, String(n), Math.round(it.x * 10) / 10, Math.round(it.y * 10) / 10]);
  }
}
const seen = {};
for (const e of entries) { const k = e[0] + '|' + e[1]; seen[k] = (seen[k] || 0) + 1; }
const clean = entries.filter(e => seen[e[0] + '|' + e[1]] === 1);
const perBlock = {};
for (const e of clean) perBlock[e[0]] = (perBlock[e[0]] || 0) + 1;
console.log('\nentries:', clean.length, '(dropped', entries.length - clean.length, 'dup-lot)');
console.log('per block:', JSON.stringify(perBlock));

/* ---------- validation ---------- */
const em2 = new Map(clean.map(e => [e[0] + '|' + e[1], e]));
const errs = [];
for (const p of pins) {
  if (p.lot == null) continue;
  const e = em2.get(p.block + '|' + p.lot);
  if (!e) continue;
  const q = applyT(T, e[2], e[3]);
  errs.push({ b: p.block, lot: p.lot, d: Math.hypot(q.e - p.e, q.n - p.n) });
}
console.log('\nlot-level ground truth (' + errs.length + '):', errs.map(x => `${x.b}-${x.lot}:${x.d.toFixed(0)}m`).join(' '));
const gtMed = errs.length ? med(errs.map(x => x.d)) : null;
console.log('median:', gtMed && gtMed.toFixed(1), 'm');

const perBlockPinErr = {};
for (const p of pins) {
  const es = clean.filter(e => e[0] === p.block);
  if (!es.length) continue;
  let bd = 1e9;
  for (const e of es) {
    const q = applyT(T, e[2], e[3]);
    bd = Math.min(bd, Math.hypot(q.e - p.e, q.n - p.n));
  }
  (perBlockPinErr[p.block] = perBlockPinErr[p.block] || []).push(bd);
}
console.log('median pin -> nearest same-block drawn lot:');
const blockQuality = {};
for (const [b, ds] of Object.entries(perBlockPinErr).sort()) {
  const m = med(ds);
  blockQuality[b] = m;
  console.log(`  ${b}: ${m.toFixed(1)} m (${ds.length} pins)`);
}
// gate: drop blocks whose pins sit far from every drawn lot (bad assignment)
const badBlocks = Object.entries(blockQuality).filter(([b, m]) => m > 22).map(([b]) => b);
const final = clean.filter(e => !badBlocks.includes(e[0]));
if (badBlocks.length) console.log('DROPPED blocks failing pin gate:', badBlocks.join(' '));
const finalPer = {};
for (const e of final) finalPer[e[0]] = (finalPer[e[0]] || 0) + 1;
console.log('final entries:', final.length, JSON.stringify(finalPer));

/* ---------- emit ---------- */
// grave-numbered blocks that actually shipped entries -> the app's lot/grave swap list
const sgBlocks = [...new Set(final.filter(e => !isLotBlock[e[0]]).map(e => e[0]))].sort();
console.log('sgBlocks (grave-numbered, shipped):', sgBlocks.join(' ') || '(none)');
const looMedian = Math.round((gtMed != null ? gtMed : 15) * 10) / 10;
const quality = looMedian <= 6 ? 'good' : looMedian <= 12 ? 'fair' : 'approx';
const geom = {
  sections: {},
  maps: [{
    file: 'riverside-cemetery-map-alma-mi', section: '*', sub: '', style: 'blocks',
    page: { w: texts.w, h: texts.h },
    transform: T, quality, looMedian,
    entries: final,
  }],
  sgBlocks,
  declination: cem.declination != null ? cem.declination : -6.6,
};
fs.writeFileSync('riverside-geometry.json', JSON.stringify(geom));
console.log('\nwrote riverside-geometry.json:', final.length, 'entries, quality', quality, 'looMedian', looMedian);

/* ---------- verification SVG: drawn lots (dots per block) vs GPS pins (crosses) ---------- */
{
  const pts = final.map(e => ({ ...applyT(T, e[2], e[3]), b: e[0], lot: e[1] }));
  const all = [...pts, ...pins];
  const minE = Math.min(...all.map(p => p.e)) - 20, maxE = Math.max(...all.map(p => p.e)) + 20;
  const minN = Math.min(...all.map(p => p.n)) - 20, maxN = Math.max(...all.map(p => p.n)) + 20;
  const W = 1100, H = Math.round(W * (maxN - minN) / (maxE - minE));
  const sx = e => (e - minE) / (maxE - minE) * W;
  const sy = n => H - (n - minN) / (maxN - minN) * H;
  const colors = { B:'#e6194b',C:'#3cb44b',D:'#4363d8',K:'#f58231',S:'#911eb4',W:'#42d4f4',U:'#f032e6',OLD:'#9a6324',L:'#808000',H:'#469990' };
  const col = b => colors[b] || '#666';
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#101418"/>` +
    `<text x="12" y="22" fill="#ccc" font-family="sans-serif" font-size="14">Riverside (Alma) — drawn lots (dots) vs FAG GPS pins (crosses), colored by block</text>`;
  for (const p of pts)
    svg += `<circle cx="${sx(p.e).toFixed(1)}" cy="${sy(p.n).toFixed(1)}" r="2.4" fill="${col(p.b)}"/>`;
  for (const p of pins) {
    const x = sx(p.e), y = sy(p.n);
    svg += `<path d="M${(x-4).toFixed(1)} ${y.toFixed(1)}H${(x+4).toFixed(1)}M${x.toFixed(1)} ${(y-4).toFixed(1)}V${(y+4).toFixed(1)}" stroke="${col(p.block)}" stroke-width="1.4" opacity="0.9"/>`;
  }
  // block letters at entry centroids
  const bc = {};
  for (const p of pts) { (bc[p.b] = bc[p.b] || []).push(p); }
  for (const [b, ps] of Object.entries(bc)) {
    const ce = ps.reduce((s, p) => s + p.e, 0) / ps.length, cn = ps.reduce((s, p) => s + p.n, 0) / ps.length;
    svg += `<text x="${sx(ce).toFixed(1)}" y="${sy(cn).toFixed(1)}" fill="#fff" font-family="sans-serif" font-size="26" font-weight="bold" opacity="0.85" text-anchor="middle">${b}</text>`;
  }
  svg += '</svg>';
  fs.writeFileSync('riverside-verify.svg', svg);
  console.log('wrote riverside-verify.svg');
}
