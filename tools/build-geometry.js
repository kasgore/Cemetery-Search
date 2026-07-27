// Build georeferenced lot-grid geometry from the city plat maps + FAG GPS anchors.
// Outputs plat-geometry.json: per-map lot entries (page coords), affine page->local-meters
// transforms, quality stats; plus per-section centroid fallbacks.
const fs = require('fs');

const CEM = { lat: 43.4202995, lng: -84.6136017 };
const R = 6371000;
const M_PER_DEG_LAT = Math.PI / 180 * R;                       // ~111194
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(CEM.lat * Math.PI / 180);
const toEN = (lat, lng) => ({ e: (lng - CEM.lng) * M_PER_DEG_LNG, n: (lat - CEM.lat) * M_PER_DEG_LAT });
const toLL = (e, n) => ({ lat: CEM.lat + n / M_PER_DEG_LAT, lng: CEM.lng + e / M_PER_DEG_LNG });

/* ---------- canonical sections ---------- */
// canonical key -> { name, bsaCodes (Section field values), maps }
const MAPS = [
  { file: 'square-hill-east-map-sec-11', section: 'Square Hill', style: 'blocks' },
  { file: 'square-hill-west-map-sub-11', section: 'Square Hill', style: 'blocks' },
  { file: 'hoffstetter-hill-east-map-sub-12', section: 'Hofstetter Hill', style: 'blocks' },
  { file: 'hoffstetter-hill-west-map-sub-12', section: 'Hofstetter Hill', style: 'blocks' },
  { file: 'cutler-hill-map-sub-13', section: 'Cutler Hill', style: 'blocks' },
  { file: 'round-hill-map-sub-10', section: 'Round Hill', style: 'blocks' },
  { file: 'vault-hill-map-sub-6', section: 'Vault Hill', style: 'blocks' },
  { file: 'north-hill-east-map-sub-17', section: 'North Hill', style: 'blocks' },
  { file: 'north-hill-west-map-sub-17', section: 'North Hill', style: 'blocks' },
  { file: 'veterans-hill-map-sub-16', section: 'Veteran Hill', style: 'blocks' },
  { file: 'morris-hill-map-sub-15', section: 'Morris Hill', style: 'numblocks' },
  { file: 'oak-hill-map-sub-7', section: 'Oak Hill', style: 'lots' },
  { file: 'old-part-map-sub-1', section: 'Old Part', sub: '1', style: 'lots' },
  { file: 'old-part-map-sub-2', section: 'Old Part', sub: '2', style: 'lots' },
  { file: 'old-part-map-sub-3', section: 'Old Part', sub: '3', style: 'lots' },
  { file: 'old-part-map-sub-4', section: 'Old Part', sub: '4', style: 'lots' },
  { file: 'old-part-map-sub-5', section: 'Old Part', sub: '5', style: 'lots' },
  { file: 'single-grave-section-map-sub-14', section: 'Single Grave', style: 'rows' },
];

/* ---------- plot string parser (shared with app later) ---------- */
const SECTION_PATTERNS = [
  [/^(?:sub\.?\s*12\s+)?hoff?stett?er\s+hil?l?|^hostetter\s+hill/i, 'Hofstetter Hill'],
  [/^squ?are?\s+hh?il?l|^section\s+11|^sub\s+11/i, 'Square Hill'],
  [/^round\s+hill|^sub\s+10/i, 'Round Hill'],
  [/^north\s?hill|^sub\s+17/i, 'North Hill'],
  [/^cutler\s+hill|^culter\s+hill|^sub\s+13/i, 'Cutler Hill'],
  [/^vault\s+hill|^sub\s+6\b/i, 'Vault Hill'],
  [/^morris\s+hill|^sub\s+15/i, 'Morris Hill'],
  [/^veterans?\s+hill|^sub\s+16/i, 'Veteran Hill'],
  [/^mausoleum|^sub\s+9\b/i, 'Mausoleum'],
  [/^singles?(\s+grave)?(\s+sec(tion)?)?|^sub\s+14/i, 'Single Grave'],
  [/^old\s+part|^sub\s+[1-5]\b/i, 'Old Part'],
  [/oak\s+hill|^sub\.?\s*7\b|^subdiv\s+7|^section\s+7\b/i, 'Oak Hill'],
];
function parsePlot(plotStr) {
  if (!plotStr) return null;
  let s = String(plotStr).replace(/[().,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /no location|unknown|pottersfield/i.test(s)) return null;
  let section = null;
  for (const [re, name] of SECTION_PATTERNS) if (re.test(s)) { section = name; break; }
  if (!section) return null;
  let sub = (s.match(/\bSub\.?\s*:?\s*(\d+)\b/i) || [])[1] || '';
  let block = ((s.match(/\b(?:Blk|Block|Row)\s+([A-Z]{1,2}|\d{1,3})\b/i) || [])[1] || '').toUpperCase().replace(/^0+(?=\d)/, '');
  let lot = (s.match(/\bLot:?\s*#?\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  const grave = (s.match(/\b(?:Grave|Space|Plot)\s+([0-9]+(?:[-/][0-9]+)?)\b/i) || [])[1] || '';
  if (section === 'Old Part' && !sub) {
    const m2 = s.match(/^old\s+part\s+(?:sec(?:tion)?\s+)?([1-5])\b/i);
    if (m2) sub = m2[1];
    else if (/^[1-5]$/.test(block)) { sub = block; block = ''; }
  }
  // lot ranges "50-52" or "31/32" -> first number
  const lotNum = parseInt(lot); // NaN for e.g. "CC"
  return { section, sub, block, lot, lotNum: isFinite(lotNum) ? lotNum : null, grave, raw: plotStr };
}

/* ---------- load map label data ---------- */
function loadMapEntries(cfg) {
  const d = JSON.parse(fs.readFileSync(`map-texts/${cfg.file}.json`, 'utf8'));
  const pg = d.pages[0];
  const items = pg.items;
  const nums = items.filter(i => /^\d{1,4}$/.test(i.s)).map(i => ({ ...i, v: parseInt(i.s) }));
  if (!nums.length) return { cfg, page: pg, entries: [], blocks: [], roads: [] };
  // dominant lot font
  const fhCount = {};
  nums.forEach(n => fhCount[n.fh] = (fhCount[n.fh] || 0) + 1);
  const lotFh = +Object.entries(fhCount).sort((a, b) => b[1] - a[1])[0][0];
  const lotNums = nums.filter(n => Math.abs(n.fh - lotFh) < 0.75);

  const roads = items.filter(i => /^road$/i.test(i.s)).map(i => ({ x: i.x, y: i.y }));

  let blocks = [];
  if (cfg.style === 'blocks') {
    blocks = items.filter(i => /^[A-Z]$/.test(i.s) && i.fh >= 9 && i.fh < 11.8 && !(i.x < 45 && i.fh >= 11))
      .map(i => ({ b: i.s, x: i.x, y: i.y }));
  } else if (cfg.style === 'numblocks') {
    // numeric block labels: bigger font than lots
    blocks = nums.filter(n => n.fh > lotFh + 0.9).map(i => ({ b: i.s, x: i.x, y: i.y }));
  }

  let entries = [];
  if (cfg.style === 'blocks' || cfg.style === 'numblocks') {
    if (blocks.length) {
      // Assignment happens later (delta grid search); return raw lot labels too.
      return { cfg, page: pg, lotNums, blocks, roads };
    }
  } else if (cfg.style === 'lots') {
    entries = lotNums.map(n => ({ b: '', l: n.s, x: n.x, y: n.y }));
  } else if (cfg.style === 'rows') {
    // Single Grave: cluster labels into y-bands = rows; numbering resolved against anchors later.
    const sorted = [...lotNums].sort((a, b) => a.y - b.y);
    const bands = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].y - sorted[i - 1].y > 12) { bands.push(cur); cur = []; }
      cur.push(sorted[i]);
    }
    bands.push(cur);
    // keep bands with >=5 labels as grave rows
    const rows = bands.filter(b => b.length >= 5);
    rows.forEach((band, idx) => {
      band.forEach(n => entries.push({ rowIdx: idx, b: '', l: n.s, x: n.x, y: n.y }));
    });
    return { cfg, page: pg, entries, blocks, roads, rowCount: rows.length };
  }
  return { cfg, page: pg, entries, blocks, roads };
}

/* ---------- anchors ---------- */
function loadAnchors() {
  const d = JSON.parse(fs.readFileSync('memorials.json', 'utf8'));
  const seenCoord = {};
  const anchors = [];
  for (const r of d.records) {
    if (!r.latitude || !r.longitude || !r.plot) continue;
    const lat = parseFloat(r.latitude), lng = parseFloat(r.longitude);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    const { e, n } = toEN(lat, lng);
    const dc = Math.hypot(e, n);
    if (dc > 500) continue; // off-site junk pins
    if (dc < 5) continue;   // default pin exactly at the cemetery centroid
    const p = parsePlot(r.plot);
    if (!p) continue;
    const ck = lat.toFixed(6) + ',' + lng.toFixed(6);
    seenCoord[ck] = (seenCoord[ck] || 0) + 1;
    anchors.push({ id: r.memorialId, lat, lng, e, n, ck, ...p });
  }
  // weight: 1/sqrt(count at same exact coordinate) - bulk pins count less
  anchors.forEach(a => a.w = 1 / Math.sqrt(seenCoord[a.ck]));
  return anchors;
}

/* ---------- weighted affine fit: page(x,y) -> world(e,n) ---------- */
function fitAffine(pairs) {
  // solve e = a*x + b*y + c ; n = d*x + f*y + g  (weighted least squares)
  if (pairs.length < 4) return null;
  const solve3 = (rows, tKey) => {
    // normal equations for [k1,k2,k3] over basis [x, y, 1]
    let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], T = [0, 0, 0];
    for (const p of rows) {
      const basis = [p.x, p.y, 1], w = p.w || 1;
      for (let i = 0; i < 3; i++) {
        T[i] += w * basis[i] * p[tKey];
        for (let j = 0; j < 3; j++) S[i][j] += w * basis[i] * basis[j];
      }
    }
    // gaussian elimination
    const M = S.map((row, i) => [...row, T[i]]);
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r2 = col + 1; r2 < 3; r2++) if (Math.abs(M[r2][col]) > Math.abs(M[piv][col])) piv = r2;
      if (Math.abs(M[piv][col]) < 1e-9) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r2 = 0; r2 < 3; r2++) {
        if (r2 === col) continue;
        const f = M[r2][col] / M[col][col];
        for (let c2 = col; c2 < 4; c2++) M[r2][c2] -= f * M[col][c2];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  };
  const A = solve3(pairs, 'e'), B = solve3(pairs, 'n');
  if (!A || !B) return null;
  return { a: A[0], b: A[1], c: A[2], d: B[0], f: B[1], g: B[2] };
}
const applyAffine = (T, x, y) => ({ e: T.a * x + T.b * y + T.c, n: T.d * x + T.f * y + T.g });

function robustFit(pairs, inlierM = 13) {
  if (pairs.length < 4) return { T: null, used: 0 };
  // Mini-RANSAC: exact affine from triples, count inliers, refit on best consensus set.
  const n = pairs.length;
  let best = null;
  const tryTriple = (i, j, k) => {
    const tri = [pairs[i], pairs[j], pairs[k]];
    // degenerate (near-collinear in page space) -> skip
    const area = Math.abs((tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[2].x - tri[0].x) * (tri[1].y - tri[0].y));
    if (area < 400) return;
    const T = fitAffine([...tri, { ...tri[0] }]); // fitAffine wants >=4 rows; duplicate one (exact fit still)
    if (!T) return;
    const inliers = pairs.filter(p => { const q = applyAffine(T, p.x, p.y); return Math.hypot(q.e - p.e, q.n - p.n) <= inlierM; });
    if (inliers.length >= 4 && (!best || inliers.length > best.length)) best = inliers;
  };
  if (n <= 26) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) tryTriple(i, j, k);
  } else {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let it = 0; it < 4000; it++) {
      const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n), k = Math.floor(rnd() * n);
      if (i !== j && j !== k && i !== k) tryTriple(i, j, k);
    }
  }
  if (!best) return { T: null, used: 0 };
  // refit on inliers, then expand: re-include any pair now within threshold, refit once more
  let T = fitAffine(best);
  if (!T) return { T: null, used: 0 };
  const expanded = pairs.filter(p => { const q = applyAffine(T, p.x, p.y); return Math.hypot(q.e - p.e, q.n - p.n) <= inlierM; });
  if (expanded.length >= 4) { T = fitAffine(expanded) || T; return { T, used: expanded.length, pairs: expanded }; }
  return { T, used: best.length, pairs: best };
}

function looStats(pairs) {
  if (pairs.length < 5) return null;
  const errs = [];
  for (let i = 0; i < pairs.length; i++) {
    const rest = pairs.filter((_, j) => j !== i);
    const T = fitAffine(rest);
    if (!T) continue;
    const q = applyAffine(T, pairs[i].x, pairs[i].y);
    errs.push(Math.hypot(q.e - pairs[i].e, q.n - pairs[i].n));
  }
  errs.sort((a, b) => a - b);
  const p = q => +errs[Math.floor(q * (errs.length - 1))].toFixed(1);
  return { n: errs.length, median: p(0.5), p75: p(0.75), p90: p(0.9) };
}

/* ---------- band assignment with offset delta ---------- */
function assignByDelta(lotNums, blocks, delta) {
  const sorted = [...blocks].sort((a, b) => a.y - b.y);
  const bandH = sorted.length > 1 ? (sorted[sorted.length - 1].y - sorted[0].y) / (sorted.length - 1) : 60;
  const entries = [];
  for (const n of lotNums) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const d0 = Math.abs(n.y - (sorted[i].y + delta));
      if (d0 < bestD) { bestD = d0; best = i; }
    }
    if (bestD > bandH * 0.75) continue; // too far from any band center
    entries.push({ b: sorted[best].b, l: n.s, x: n.x, y: n.y });
  }
  return entries;
}

function buildPairs(entries, secAnchors, style) {
  const entryKey = {};
  for (const en of entries) {
    const k = (en.b || '') + '|' + (parseInt(en.l) || en.l);
    (entryKey[k] = entryKey[k] || []).push(en);
  }
  const pairs = [];
  for (const a of secAnchors) {
    if (a.lotNum == null) continue;
    const k = (style === 'lots' ? '' : a.block) + '|' + a.lotNum;
    const ens = entryKey[k];
    if (!ens || ens.length !== 1) continue;
    pairs.push({ x: ens[0].x, y: ens[0].y, e: a.e, n: a.n, w: a.w });
  }
  return pairs;
}

function medianLoo(pairs) {
  const s = looStats(pairs);
  return s ? s.median : Infinity;
}

/* ---------- main ---------- */
const anchors = loadAnchors();
console.log('anchors loaded:', anchors.length);

const out = { generated: '2026-07-26', cem: CEM, maps: [], sections: {} };

// section centroids (fallback): weighted median-ish via trimmed mean
const bySection = {};
for (const a of anchors) (bySection[a.section] = bySection[a.section] || []).push(a);
for (const [sec, list] of Object.entries(bySection)) {
  const es = list.map(a => a.e).sort((a, b) => a - b), ns = list.map(a => a.n).sort((a, b) => a - b);
  const med = arr => arr[Math.floor(arr.length / 2)];
  const c = toLL(med(es), med(ns));
  out.sections[sec] = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), anchors: list.length };
}

const results = [];
for (const cfg of MAPS) {
  const m = loadMapEntries(cfg);
  const secAnchors = anchors.filter(a => a.section === cfg.section && (!cfg.sub || a.sub === cfg.sub || (!a.sub && cfg.section !== 'Old Part')));

  let entries = m.entries || [];
  let bestDelta = null;

  if ((cfg.style === 'blocks' || cfg.style === 'numblocks') && m.blocks.length) {
    // grid-search the band offset delta against LOO error
    const sorted = [...m.blocks].sort((a, b) => a.y - b.y);
    const bandH = sorted.length > 1 ? (sorted[sorted.length - 1].y - sorted[0].y) / (sorted.length - 1) : 60;
    let best = { loo: Infinity, entries: null, delta: null, pairs: [] };
    for (let delta = -Math.round(bandH * 0.6); delta <= Math.round(bandH * 0.6); delta += 2) {
      const ents = assignByDelta(m.lotNums, m.blocks, delta);
      const pairs = buildPairs(ents, secAnchors, cfg.style);
      if (pairs.length < 5) continue;
      const rf = robustFit(pairs);
      if (!rf.T || !rf.pairs || rf.pairs.length < 5) continue;
      const err = medianLoo(rf.pairs);
      // prefer more matched pairs when errors are close (within 20%)
      const better = err < best.loo * 0.8 || (err < best.loo * 1.2 && pairs.length > best.pairs.length);
      if (best.entries === null || better) best = { loo: err, entries: ents, delta, pairs };
    }
    if (best.entries) { entries = best.entries; bestDelta = best.delta; }
    else entries = assignByDelta(m.lotNums, m.blocks, bandH / 2); // no anchors: center-of-band guess
  }

  if (cfg.style === 'rows' && m.entries.length) {
    // Single Grave: rows clustered top-to-bottom; resolve row numbering vs anchors (both directions, offsets 0/1)
    const rowCount = m.rowCount;
    let best = { loo: Infinity, entries: null };
    for (const dir of [1, -1]) {
      for (const off of [0, 1, 2]) {
        const ents = m.entries.map(en => ({
          b: String(dir === 1 ? en.rowIdx + 1 + off : rowCount - en.rowIdx + off), l: en.l, x: en.x, y: en.y,
        }));
        const pairs = buildPairs(ents, secAnchors, 'blocks');
        if (pairs.length < 4) continue;
        const rf = robustFit(pairs);
        if (!rf.T) continue;
        const err = pairs.length >= 5 ? medianLoo(rf.pairs || pairs) : 999;
        if (err < best.loo) best = { loo: err, entries: ents };
      }
    }
    if (best.entries) entries = best.entries;
    else entries = m.entries.map(en => ({ b: String(en.rowIdx + 1), l: en.l, x: en.x, y: en.y }));
  }

  const pairs = buildPairs(entries, secAnchors, cfg.style);
  let fit = { T: null, used: 0 };
  let loo = null;
  if (pairs.length >= 5) {
    fit = robustFit(pairs);
    if (fit.T && fit.pairs) loo = looStats(fit.pairs);
  }
  results.push({ cfg, m, entries, pairs, fit, loo, bestDelta });
}

/* ---------- fit trust metrics ---------- */
function fitTrust(r) {
  if (!r.fit.T || !r.fit.pairs) return null;
  const inl = r.fit.pairs;
  const coords = new Set(inl.map(p => p.e.toFixed(1) + ',' + p.n.toFixed(1)));
  const mx = inl.reduce((s, p) => s + p.x, 0) / inl.length, my = inl.reduce((s, p) => s + p.y, 0) / inl.length;
  const spread = Math.sqrt(inl.reduce((s, p) => s + ((p.x - mx) ** 2 + (p.y - my) ** 2), 0) / inl.length);
  return { distinctCoords: coords.size, spreadPage: spread };
}

/* ---------- consensus rotation/scale from high-trust fits ---------- */
const medOf = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const highTrust = results.filter(r => {
  const t = fitTrust(r);
  return t && r.loo && r.loo.median <= 12 && t.distinctCoords >= 6 && t.spreadPage >= 90;
});
const rots = highTrust.map(r => Math.atan2(r.fit.T.d, r.fit.T.a));
const scales = highTrust.map(r => Math.hypot(r.fit.T.a, r.fit.T.d));
const consRot = rots.length ? medOf(rots) : 0;
const consScale = scales.length ? medOf(scales) : 0.35;
console.log(`consensus: rotation=${(consRot * 180 / Math.PI).toFixed(1)} deg  scale=${consScale.toFixed(4)} m/pt from ${highTrust.length} high-trust maps: ${highTrust.map(r => r.cfg.file.split('-map')[0]).join(', ')}`);

/* ---------- finalize: accept trusted affine, else similarity fallback ---------- */
for (const r of results) {
  const { cfg, m } = r;
  let transform = null, quality = 'none';
  const t = fitTrust(r);
  let affineOk = false;
  if (r.fit.T && r.loo && r.loo.median <= 20 && t) {
    const rot = Math.atan2(r.fit.T.d, r.fit.T.a), sc = Math.hypot(r.fit.T.a, r.fit.T.d);
    const rotDev = Math.abs(((rot - consRot) * 180 / Math.PI + 540) % 360 - 180);
    const scRatio = sc / consScale;
    const consistent = rotDev <= 7 && scRatio >= 0.8 && scRatio <= 1.25;
    const wellSupported = t.distinctCoords >= 6 && t.spreadPage >= 90;
    affineOk = wellSupported || (consistent && t.distinctCoords >= 4);
    if (affineOk) {
      const T = r.fit.T;
      transform = { a: T.a, b: T.b, c: T.c, d: T.d, f: T.f, g: T.g };
      quality = (r.loo.median <= 8 && wellSupported) ? 'good' : 'fair';
    }
  }
  if (!affineOk && (r.pairs.length >= 1 || out.sections[cfg.section])) {
    // similarity fallback: consensus rotation+scale, robust median translation
    const ca = consScale * Math.cos(consRot), cd = consScale * Math.sin(consRot);
    // e = ca*x - cd*y + c ; n = cd*x + ca*y + g   (rotation matrix * scale)
    const dxs = r.pairs.map(p => p.e - (ca * p.x - cd * p.y));
    const dys = r.pairs.map(p => p.n - (cd * p.x + ca * p.y));
    // pseudo-signal: section centroid <-> mean of map entries (helps when pairs are 0-2)
    const secC = out.sections[cfg.section];
    const ents = r.entries;
    if (secC && ents.length) {
      const mex = ents.reduce((s, en) => s + en.x, 0) / ents.length, mey = ents.reduce((s, en) => s + en.y, 0) / ents.length;
      const sEN = toEN(secC.lat, secC.lng);
      dxs.push(sEN.e - (ca * mex - cd * mey));
      dys.push(sEN.n - (cd * mex + ca * mey));
    }
    if (dxs.length) {
      // densest-cluster translation: pick the offset with the most neighbors within 15 m,
      // average that cluster (robust to multi-modal junk that defeats a plain median)
      let bestIdx = 0, bestCnt = -1;
      for (let i = 0; i < dxs.length; i++) {
        const cnt = dxs.filter((_, j) => Math.hypot(dxs[j] - dxs[i], dys[j] - dys[i]) <= 15).length;
        if (cnt > bestCnt) { bestCnt = cnt; bestIdx = i; }
      }
      const cluster = dxs.map((_, j) => j).filter(j => Math.hypot(dxs[j] - dxs[bestIdx], dys[j] - dys[bestIdx]) <= 15);
      const cx = cluster.reduce((s, j) => s + dxs[j], 0) / cluster.length;
      const cy = cluster.reduce((s, j) => s + dys[j], 0) / cluster.length;
      transform = { a: ca, b: -cd, c: cx, d: cd, f: ca, g: cy };
      quality = cluster.length >= 3 ? 'approx' : 'rough';
    }
  }
  // honest accuracy: residuals of ALL matched pairs under the FINAL transform
  let acc = null;
  if (transform && r.pairs.length >= 3) {
    const errs = r.pairs.map(p => {
      const e2 = transform.a * p.x + transform.b * p.y + transform.c;
      const n2 = transform.d * p.x + transform.f * p.y + transform.g;
      return Math.hypot(e2 - p.e, n2 - p.n);
    }).sort((a, b) => a - b);
    acc = {
      median: +errs[Math.floor(errs.length / 2)].toFixed(1),
      p90: +errs[Math.floor(0.9 * (errs.length - 1))].toFixed(1),
      n: errs.length,
    };
  }
  out.maps.push({
    file: cfg.file, section: cfg.section, sub: cfg.sub || '',
    style: cfg.style, page: { w: m.page.w, h: m.page.h },
    entries: r.entries, blocks: (m.blocks || []).map(b => ({ b: b.b, x: b.x, y: b.y })), roads: m.roads,
    transform, quality, acc,
    anchorsMatched: r.pairs.length, anchorsUsed: r.fit.used || 0, loo: r.loo, delta: r.bestDelta,
  });
  console.log(`${cfg.file}: entries=${r.entries.length} pairs=${r.pairs.length} delta=${r.bestDelta} quality=${quality} acc=${acc ? acc.median + '/' + acc.p90 : '-'} loo=${r.loo ? r.loo.median : '-'}`);
}

fs.writeFileSync('plat-geometry.json', JSON.stringify(out));
console.log('wrote plat-geometry.json');
