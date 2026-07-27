/* ==========================================================
   Cemetery Search — core logic (no DOM).
   Runs in the browser (window.CS) and in Node (module.exports)
   so the whole engine is unit-testable.
   ========================================================== */
(function (root) {
'use strict';
const CS = {};

/* ---------------- geo ---------------- */
const R_EARTH = 6371000;
CS.makeProj = function (cem) {
  const mLat = Math.PI / 180 * R_EARTH;
  const mLng = mLat * Math.cos(cem.lat * Math.PI / 180);
  return {
    toEN: (lat, lng) => ({ e: (lng - cem.lng) * mLng, n: (lat - cem.lat) * mLat }),
    toLL: (e, n) => ({ lat: cem.lat + n / mLat, lng: cem.lng + e / mLng }),
  };
};
CS.distM = function (lat1, lng1, lat2, lng2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
CS.bearingDeg = function (lat1, lng1, lat2, lng2) {
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dl = (lng2 - lng1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

/* ---------------- plot parsing ---------------- */
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
  [/^singles?(\s+grave)?(\s+sec(tion)?)?\b|^sub\s+14/i, 'Single Grave'],
  [/^old\s+part|^sub\s+[1-5]\b/i, 'Old Part'],
  [/oak\s+hill|^sub\.?\s*7\b|^subdiv\s+7|^section\s+7\b/i, 'Oak Hill'],
];
const normBlock = b => String(b || '').toUpperCase().replace(/^0+(?=\d)/, '');
CS.normBlock = normBlock;
CS.parsePlot = function (plotStr) {
  if (!plotStr) return null;
  const s = String(plotStr).replace(/[().,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /no location|unknown|pottersfield/i.test(s)) return null;
  let section = null;
  for (const [re, name] of SECTION_PATTERNS) if (re.test(s)) { section = name; break; }
  if (!section) return null;
  let sub = (s.match(/\bSub\.?\s*:?\s*(\d+)\b/i) || [])[1] || '';
  let block = normBlock((s.match(/\b(?:Blk|Block|Row)\s+([A-Z]{1,2}|\d{1,3})\b/i) || [])[1] || '');
  const lot = (s.match(/\bLot:?\s*#?\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  const grave = (s.match(/\b(?:Grave|Space|Plot)\s+([0-9]+(?:[-/][0-9]+)?)\b/i) || [])[1] || '';
  // Old Part: subs 1-5 are often written without the word "Sub"
  if (section === 'Old Part' && !sub) {
    const m = s.match(/^old\s+part\s+(?:sec(?:tion)?\s+)?([1-5])\b/i);
    if (m) sub = m[1];
    else if (/^[1-5]$/.test(block)) { sub = block; block = ''; }
  }
  const lotNum = parseInt(lot);
  return { section, sub, block, lot: isFinite(lotNum) ? String(lotNum) : lot, grave };
};
// BS&A plot code e.g. OAKGROVE-11-B-051-3 / OAKGROVE-14-10--12
const BSA_SECTION = {
  '01': ['Old Part', '1'], '02': ['Old Part', '2'], '03': ['Old Part', '3'], '04': ['Old Part', '4'], '05': ['Old Part', '5'],
  '1': ['Old Part', '1'], '2': ['Old Part', '2'], '3': ['Old Part', '3'], '4': ['Old Part', '4'], '5': ['Old Part', '5'],
  '06': ['Vault Hill', ''], '6': ['Vault Hill', ''], '07': ['Oak Hill', ''], '7': ['Oak Hill', ''],
  '09': ['Mausoleum', ''], '9': ['Mausoleum', ''], '10': ['Round Hill', ''], '11': ['Square Hill', ''],
  '12': ['Hofstetter Hill', ''], '13': ['Cutler Hill', ''], '14': ['Single Grave', ''],
  '15': ['Morris Hill', ''], '16': ['Veteran Hill', ''], '17': ['North Hill', ''],
  // 25 is the city's catch-all for old burials with UNKNOWN plots (290 records all at
  // "block 158 lot 4") — a real register entry but never a location.
  '25': ['', ''],
};
CS.BSA_SECTION = BSA_SECTION;
CS.parseBsaCode = function (code) {
  const m = String(code || '').trim().match(/^([A-Z]+)-(\d+)-([A-Z0-9]*)-([A-Z0-9]*)-?([0-9]*)$/i);
  if (!m) return null;
  const canon = BSA_SECTION[m[2]] || BSA_SECTION[m[2].replace(/^0/, '')];
  return {
    section: canon ? canon[0] : ('Section ' + m[2]),
    sub: canon ? canon[1] : '',
    block: normBlock(m[3] || ''),
    lot: (m[4] || '').replace(/^0+(?=\d)/, ''),
    grave: m[5] || '',
  };
};

/* ---------------- names ---------------- */
const NICK = {
  abe:'abraham', al:'albert', alex:'alexander', andy:'andrew', art:'arthur', barb:'barbara', bart:'bartholomew',
  bea:'beatrice', becky:'rebecca', bell:'isabella', belle:'isabella', ben:'benjamin', bert:'albert', bess:'elizabeth',
  bessie:'elizabeth', beth:'elizabeth', betsy:'elizabeth', betty:'elizabeth', bill:'william', billy:'william',
  bob:'robert', bobby:'robert', carrie:'caroline', cathy:'catherine', charley:'charles', charlie:'charles',
  chas:'charles', chris:'christopher', chuck:'charles', cindy:'cynthia', dan:'daniel', danny:'daniel',
  dave:'david', davy:'david', deb:'deborah', debbie:'deborah', dick:'richard', don:'donald', donnie:'donald',
  dora:'dorothy', dot:'dorothy', dottie:'dorothy', ed:'edward', eddie:'edward', edw:'edward', effie:'euphemia',
  ella:'eleanor', ellen:'eleanor', elsie:'elizabeth', fannie:'frances', fanny:'frances', flo:'florence',
  fran:'frances', frank:'franklin', fred:'frederick', freddie:'frederick', gene:'eugene', geo:'george',
  gerry:'gerald', gus:'augustus', hal:'harold', hank:'henry', hattie:'harriet', harry:'henry', herb:'herbert',
  hetty:'henrietta', jack:'john', jackie:'jacqueline', jake:'jacob', jas:'james', jen:'jennifer',
  jennie:'jane', jenny:'jane', jerry:'gerald', jim:'james', jimmy:'james', jno:'john', joe:'joseph',
  joey:'joseph', johnny:'john', jos:'joseph', josh:'joshua', josie:'josephine', kate:'catherine',
  katie:'catherine', kathy:'catherine', ken:'kenneth', kenny:'kenneth', kit:'christopher', larry:'lawrence',
  len:'leonard', lena:'helena', leo:'leonard', les:'leslie', lettie:'letitia', libby:'elizabeth',
  lige:'elijah', lizzie:'elizabeth', liz:'elizabeth', lon:'alonzo', lottie:'charlotte', lou:'louis',
  louie:'louis', lucy:'lucille', mabel:'mabelle', maggie:'margaret', mame:'mary', mamie:'mary',
  mandy:'amanda', margie:'margaret', marty:'martin', mat:'matthew', matt:'matthew', mattie:'martha',
  max:'maxwell', meg:'margaret', mel:'melvin', mike:'michael', millie:'mildred', mina:'wilhelmina',
  minnie:'minerva', mollie:'mary', molly:'mary', nan:'nancy', nancy:'ann', nate:'nathan', ned:'edward',
  nell:'eleanor', nellie:'eleanor', nettie:'henrietta', nick:'nicholas', nora:'eleanora', pam:'pamela',
  pat:'patrick', patsy:'patricia', patty:'patricia', peg:'margaret', peggy:'margaret', pete:'peter',
  phil:'philip', polly:'mary', ray:'raymond', rich:'richard', rick:'richard', ricky:'richard',
  rob:'robert', robt:'robert', rod:'roderick', ron:'ronald', ronnie:'ronald', rose:'rosemary',
  roxie:'roxanne', rudy:'rudolph', russ:'russell', sadie:'sarah', sallie:'sarah', sally:'sarah',
  sam:'samuel', sammy:'samuel', sandy:'sandra', sherm:'sherman', sid:'sidney', sol:'solomon',
  stan:'stanley', steve:'stephen', sue:'susan', susie:'susan', ted:'theodore', teddy:'theodore',
  terry:'terrence', thos:'thomas', tillie:'matilda', tim:'timothy', timmy:'timothy', tom:'thomas',
  tommy:'thomas', tony:'anthony', trish:'patricia', vic:'victor', vin:'vincent', viv:'vivian',
  walt:'walter', wes:'wesley', will:'william', willie:'william', wm:'william', zach:'zachary', zeke:'ezekiel',
};
CS.normName = function (s) {
  return String(s || '').toLowerCase()
    .replace(/["“”'’`.]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|rev|dr|mr|mrs|col|capt|sgt|ssgt|msgt|lt|gen|pvt|cpl|pfc|sp4|sp5|maj|cmdr|ens|adm)\b/g, ' ')
    .replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim();
};
CS.canonFirst = function (first) {
  const f = CS.normName(first).split(' ')[0] || '';
  return NICK[f] || f;
};
CS.soundex = function (s) {
  s = CS.normName(s).replace(/ /g, '');
  if (!s) return '';
  const codes = { b:1,f:1,p:1,v:1, c:2,g:2,j:2,k:2,q:2,s:2,x:2,z:2, d:3,t:3, l:4, m:5,n:5, r:6 };
  let out = s[0].toUpperCase(), prev = codes[s[0]] || 0;
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const c = codes[s[i]] || 0;
    if (c && c !== prev) out += c;
    if (s[i] !== 'h' && s[i] !== 'w') prev = c;
  }
  return (out + '000').substring(0, 4);
};
// split "Last, First Middle" or "First Middle Last"; suffixes (Jr/Sr/III) are not surnames
const SUFFIX_RE = /^(jr|sr|ii|iii|iv|v)\.?,?$/i;
CS.splitName = function (full) {
  const s = String(full || '').trim();
  const lastFirst = s.match(/^([^,]+),\s*(.*)$/);
  if (lastFirst) {
    let last = lastFirst[1].trim().split(/\s+/);
    while (last.length > 1 && SUFFIX_RE.test(last[last.length - 1])) last.pop();
    return { last: last.join(' '), first: lastFirst[2].trim() };
  }
  const parts = s.split(/\s+/);
  while (parts.length > 1 && SUFFIX_RE.test(parts[parts.length - 1])) parts.pop();
  if (parts.length === 1) return { last: parts[0], first: '' };
  return { last: parts[parts.length - 1], first: parts.slice(0, -1).join(' ') };
};

/* ---------------- model ---------------- */
// Builds the unified in-memory model from the baked dataset + user updates.
CS.buildModel = function (data, updates) {
  updates = updates || {};
  const model = {
    meta: data.meta,
    proj: CS.makeProj(data.meta.cem),
    sections: data.sections || {},
    maps: data.maps || [],
    memorials: [],
    memById: new Map(),
    roster: [],
    requests: [],
    plotIndex: new Map(),   // "section|sub|block" -> [entries {who}]
  };

  /* memorials: baked, then overlay updates (by id) */
  const memRows = new Map();
  for (const m of (data.memorials || [])) memRows.set(m[0], m);
  for (const m of (updates.memorials || [])) memRows.set(m[0], m);
  for (const row of memRows.values()) {
    const [midRaw, name, maiden, by, dy, plot, lat, lng, flags] = row;
    const mid = +midRaw || null;
    if (!mid) continue;
    const p = CS.parsePlot(plot);
    const sn = CS.splitName(name && name.includes(',') ? name : nameFromFag(name));
    const mem = {
      kind: 'mem', mid, name, maiden: maiden || '', by: by || 0, dy: dy || 0,
      plot: plot || '', p, lat: lat != null ? lat : null, lng: lng != null ? lng : null,
      hasGravePhoto: !!(flags & 1), hasRequest: !!(flags & 2), veteran: !!(flags & 4),
      last: sn.last, first: sn.first,
    };
    model.memorials.push(mem);
    model.memById.set(mid, mem);
  }
  function nameFromFag(n) { return n; } // FAG fullName is "First Middle Last"

  /* roster */
  for (const row of ((updates.roster && updates.roster.length ? updates.roster : data.roster) || [])) {
    const [key, name, sex, bd, dd, burial, section, sub, block, lot, grave, status, flags, note, formerName] = row;
    const sn = CS.splitName(name);
    const yOf = s => { const m = String(s || '').match(/\b(1[6-9]\d\d|20\d\d)\b/); return m ? +m[1] : 0; };
    let rLot = String(lot || ''), rGrave = String(grave || '');
    // Single Grave: BS&A stores the cell number in the grave field (OAKGROVE-14-{row}--{cell})
    if (section === 'Single Grave' && !rLot && rGrave) { rLot = rGrave; rGrave = ''; }
    model.roster.push({
      kind: 'ros', key, name, sex: sex || '', bd: bd || '', dd: dd || '', burial: burial || '',
      by: yOf(bd), dy: yOf(dd) || yOf(burial),
      section: section || '', sub: sub || '', block: normBlock(block),
      lot: rLot, grave: rGrave,
      status: status || '', veteran: !!(flags & 4), note: note || '', formerName: formerName || '',
      last: sn.last, first: sn.first,
    });
  }

  /* requests: updates replace baked entirely (a refresh is a full snapshot) */
  const reqRows = (updates.requests && updates.requests.length ? updates.requests : data.requests) || [];
  for (const r of reqRows) {
    const mid = +r.mid || null;
    if (!mid) continue;
    model.requests.push({
      kind: 'req',
      prId: r.prId, mid, name: r.name || ((r.fn || '') + ' ' + (r.ln || '')).trim(),
      fn: r.fn || '', ln: r.ln || '', by: r.by || null, dy: r.dy || null,
      bd: r.bd || '', dd: r.dd || '', plot: r.plot || '', notes: r.notes || '',
      req: r.req || '', created: r.created || '',
      lat: r.lat != null ? r.lat : null, lng: r.lng != null ? r.lng : null,
      p: CS.parsePlot(r.plot),
    });
  }

  buildPlotIndex(model);
  matchRosterToMemorials(model);
  for (const req of model.requests) enrichRequest(model, req);
  return model;
};

// Sections whose maps are lots-only (lot numbers unique per sub) — the register's
// legacy numeric blocks would otherwise split neighbors into disjoint buckets.
const LOTS_SECTIONS = { 'Old Part': 1, 'Oak Hill': 1 };
function plotKey(section, sub, block) {
  if (LOTS_SECTIONS[section]) return section + '|' + (sub || '') + '|';
  return section + '||' + (block || '');
}
function buildPlotIndex(model) {
  const idx = model.plotIndex;
  const add = (p, who) => {
    if (!p || !p.section) return;
    const k = plotKey(p.section, p.sub, p.block);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push({ p, who });
  };
  for (const m of model.memorials) add(m.p, m);
  for (const r of model.roster) {
    if (!r.section) continue;
    add({ section: r.section, sub: r.sub, block: r.block, lot: r.lot, grave: r.grave }, r);
  }
}

/* roster <-> memorial matching */
function matchRosterToMemorials(model) {
  const byLast = new Map();
  for (const m of model.memorials) {
    const keyA = CS.normName(m.last);
    const keyB = CS.soundex(m.last);
    for (const k of [ 'n:' + keyA, 's:' + keyB ]) {
      if (!byLast.has(k)) byLast.set(k, []);
      byLast.get(k).push(m);
    }
    if (m.maiden) {
      const k = 'n:' + CS.normName(m.maiden);
      if (!byLast.has(k)) byLast.set(k, []);
      byLast.get(k).push(m);
    }
  }
  for (const r of model.roster) {
    const cands = new Set();
    for (const m of (byLast.get('n:' + CS.normName(r.last)) || [])) cands.add(m);
    for (const m of (byLast.get('s:' + CS.soundex(r.last)) || [])) cands.add(m);
    if (r.formerName) {
      const fn = CS.splitName(r.formerName);
      for (const m of (byLast.get('n:' + CS.normName(fn.last || r.formerName)) || [])) cands.add(m);
    }
    let best = null, bestScore = 0, second = 0;
    for (const m of cands) {
      const s = scorePair(r, m);
      if (s > bestScore) { second = bestScore; bestScore = s; best = m; }
      else if (s > second) second = s;
    }
    if (best && bestScore >= 70 && bestScore - second >= 15) {
      r.mem = best;
      if (!best.ros || best.rosScore < bestScore) { best.ros = r; best.rosScore = bestScore; }
    } else if (best && bestScore >= 55) {
      r.memMaybe = best;
    }
  }
}
function scorePair(r, m) {
  let s = 0;
  const rl = CS.normName(r.last), ml = CS.normName(m.last), mm = CS.normName(m.maiden);
  if (rl && (rl === ml || rl === mm)) s += 30;
  else if (CS.soundex(r.last) === CS.soundex(m.last)) s += 18;
  else return 0;
  const rf = CS.canonFirst(r.first), mf = CS.canonFirst(m.first);
  const rfRaw = CS.normName(r.first).split(' ')[0] || '', mfRaw = CS.normName(m.first).split(' ')[0] || '';
  if (rf && mf) {
    if (rf === mf || rfRaw === mfRaw) s += 30;
    else if (rfRaw && mfRaw && (rfRaw.startsWith(mfRaw) || mfRaw.startsWith(rfRaw))) s += 20;
    else if (rfRaw.length === 1 || mfRaw.length === 1) { if (rfRaw[0] === mfRaw[0]) s += 6; }
    else if (rfRaw[0] === mfRaw[0]) s += 2;
    else s -= 40; // contradicting full first names: almost certainly a different person (spouse trap)
  }
  // years
  if (r.by && m.by) {
    const d = Math.abs(r.by - m.by);
    s += d === 0 ? 25 : d <= 1 ? 15 : d <= 3 ? 2 : -20;
  }
  if (r.dy && m.dy) {
    const d = Math.abs(r.dy - m.dy);
    s += d === 0 ? 25 : d <= 1 ? 15 : d <= 3 ? 2 : -20;
  }
  // plot agreement
  if (r.section && m.p && m.p.section) {
    if (r.section === m.p.section) {
      s += 8;
      const lotsMatch = (isFinite(+r.lot) && isFinite(+m.p.lot) && r.lot !== '' && m.p.lot !== '')
        ? String(+r.lot) === String(+m.p.lot)
        : (r.lot !== '' && String(r.lot).toUpperCase() === String(m.p.lot).toUpperCase());
      if (r.block && m.p.block && r.block === m.p.block && lotsMatch) s += 22;
    } else s -= 10;
  }
  return s;
}

/* ---------------- geometry engine ---------------- */
CS.locate = function (model, p) {
  // p: {section, sub, block, lot, grave}; returns {lat,lng,acc,level,map,xy} or null
  if (!p || !p.section) return null;
  const maps = model.maps.filter(m => m.section === p.section && (p.section !== 'Old Part' || !p.sub || m.sub === p.sub));
  const lotNum = parseInt(p.lot);
  // exact lot entry
  for (const m of maps) {
    if (!m.transform) continue;
    const hits = m.entries.filter(e => (!p.block || e[0] === p.block || m.style === 'lots') &&
      String(e[1]) === String(isFinite(lotNum) ? lotNum : p.lot) &&
      (m.style !== 'lots' || !p.block || true));
    if (hits.length === 1) {
      const ll = applyT(m.transform, hits[0][2], hits[0][3]);
      return { ...model.proj.toLL(ll.e, ll.n), acc: qualityAcc(m, 'lot'), level: 'lot', map: m, xy: [hits[0][2], hits[0][3]] };
    }
    if (hits.length > 1 && p.block) {
      const bh = hits.filter(e => e[0] === p.block);
      if (bh.length === 1) {
        const ll = applyT(m.transform, bh[0][2], bh[0][3]);
        return { ...model.proj.toLL(ll.e, ll.n), acc: qualityAcc(m, 'lot'), level: 'lot', map: m, xy: [bh[0][2], bh[0][3]] };
      }
    }
  }
  // adjacent lot interpolation (same block, numeric lots)
  if (isFinite(lotNum)) {
    for (const m of maps) {
      if (!m.transform) continue;
      const blockEnts = m.entries.filter(e => (!p.block || e[0] === p.block || m.style === 'lots') && isFinite(parseInt(e[1])));
      if (blockEnts.length >= 2) {
        const withD = blockEnts.map(e => ({ e, d: Math.abs(parseInt(e[1]) - lotNum) })).sort((a, b) => a.d - b.d);
        if (withD[0].d <= 4) {
          const near = withD.slice(0, 3).filter(x => x.d <= 6);
          let sx = 0, sy = 0, sw = 0;
          for (const x of near) { const w = 1 / (1 + x.d); sx += x.e[2] * w; sy += x.e[3] * w; sw += w; }
          const ll = applyT(m.transform, sx / sw, sy / sw);
          return { ...model.proj.toLL(ll.e, ll.n), acc: qualityAcc(m, 'adj'), level: 'adjacent', map: m, xy: [sx / sw, sy / sw] };
        }
      }
    }
  }
  // block centroid
  if (p.block) {
    for (const m of maps) {
      if (!m.transform) continue;
      const blockEnts = m.entries.filter(e => e[0] === p.block);
      if (blockEnts.length >= 2) {
        const sx = blockEnts.reduce((s, e) => s + e[2], 0) / blockEnts.length;
        const sy = blockEnts.reduce((s, e) => s + e[3], 0) / blockEnts.length;
        const ll = applyT(m.transform, sx, sy);
        return { ...model.proj.toLL(ll.e, ll.n), acc: qualityAcc(m, 'block'), level: 'block', map: m, xy: [sx, sy] };
      }
    }
  }
  // section centroid
  const sec = model.sections[p.section];
  if (sec) return { lat: sec.lat, lng: sec.lng, acc: 45, level: 'section', map: null, xy: null };
  return null;
};
function applyT(T, x, y) { return { e: T.a * x + T.b * y + T.c, n: T.d * x + T.f * y + T.g }; }
CS.applyT = applyT;
function qualityAcc(m, level) {
  const base = m.quality === 'good' ? Math.max(m.looMedian || 5, 5)
    : m.quality === 'fair' ? 11
    : m.quality === 'approx' ? 14
    : 28;
  const bump = level === 'lot' ? 0 : level === 'adj' ? 4 : 14;
  return Math.round(base + bump);
}

/* request enrichment: location + provenance */
function enrichRequest(model, req) {
  const mem = model.memById.get(req.mid);
  req.mem = mem || null;
  // roster link via memorial match, else direct fuzzy
  req.ros = (mem && mem.ros) || null;
  if (!req.ros) {
    let best = null, bestScore = 0;
    const rl = CS.normName(req.ln), rs = CS.soundex(req.ln);
    for (const r of model.roster) {
      if (CS.normName(r.last) !== rl && CS.soundex(r.last) !== rs) continue;
      const s = scorePair({ last: req.ln, first: req.fn, by: req.by, dy: req.dy, section: '', block: '', lot: '' }, {
        last: r.last, first: r.first, by: r.by, dy: r.dy, maiden: '', p: null,
      });
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best && bestScore >= 70) req.ros = best;
  }
  // best plot info: locate BOTH sources and keep whichever resolves more precisely
  req.pFag = req.p;
  req.pRos = req.ros && req.ros.section ? { section: req.ros.section, sub: req.ros.sub, block: req.ros.block, lot: req.ros.lot, grave: req.ros.grave } : null;
  req.plotConflict = !!(req.pFag && req.pRos && req.pFag.section && req.pRos.section &&
    (req.pFag.section !== req.pRos.section ||
     (req.pFag.block && req.pRos.block && req.pFag.block !== req.pRos.block) ||
     (req.pFag.lot && req.pRos.lot && isFinite(+req.pFag.lot) && isFinite(+req.pRos.lot) && String(+req.pFag.lot) !== String(+req.pRos.lot))));
  // location cascade
  if (req.lat != null && req.lng != null) {
    req.loc = { lat: req.lat, lng: req.lng, acc: 8, level: 'gps', map: null };
    req.pBest = req.pRos || req.pFag || null;
  } else {
    const LEVEL_RANK = { gps: 0, lot: 1, adjacent: 2, block: 3, section: 4 };
    const locRos = req.pRos ? CS.locate(model, req.pRos) : null;
    const locFag = req.pFag ? CS.locate(model, req.pFag) : null;
    const rank = l => l ? LEVEL_RANK[l.level] * 1000 + l.acc : Infinity;
    if (rank(locRos) <= rank(locFag)) {
      req.loc = locRos || locFag;
      req.pBest = locRos ? req.pRos : (req.pFag || req.pRos);
    } else {
      req.loc = locFag;
      req.pBest = req.pFag;
    }
    if (!req.pBest) req.pBest = req.pRos || req.pFag || null;
  }
}
CS.enrichRequest = enrichRequest;

/* ---------------- neighbors ---------------- */
CS.neighbors = function (model, p, excludeMid) {
  if (!p || !p.section) return [];
  const k = plotKey(p.section, p.sub, p.block);
  const all = model.plotIndex.get(k) || [];
  const lotNum = parseInt(p.lot);
  const seen = new Set();
  const items = [];
  for (const { p: q, who } of all) {
    if (who.kind === 'mem' && who.mid === excludeMid) continue;
    const qLot = parseInt(q.lot);
    let dist;
    if (isFinite(lotNum) && isFinite(qLot)) dist = Math.abs(qLot - lotNum);
    else if (String(q.lot) === String(p.lot)) dist = 0;
    else continue;
    if (dist > 3) continue;
    // dedupe: matched roster+memorial pairs count once (prefer memorial)
    if (who.kind === 'ros' && who.mem) continue;
    const dk = who.kind === 'mem' ? 'm' + who.mid : 'r' + who.key;
    if (seen.has(dk)) continue;
    seen.add(dk);
    items.push({
      who, lotDist: dist, lot: q.lot, grave: q.grave || '',
      name: who.name, years: yearsOf(who),
      hasPhoto: who.kind === 'mem' ? who.hasGravePhoto : (who.mem ? who.mem.hasGravePhoto : false),
      mid: who.kind === 'mem' ? who.mid : (who.mem ? who.mem.mid : null),
      fromRegister: who.kind === 'ros',
    });
  }
  items.sort((a, b) => a.lotDist - b.lotDist || (b.hasPhoto ? 1 : 0) - (a.hasPhoto ? 1 : 0) || String(a.grave).localeCompare(String(b.grave)));
  return items;
};
function yearsOf(w) {
  const by = w.by || 0, dy = w.dy || 0;
  if (!by && !dy) return '';
  return (by || '?') + '–' + (dy || '?');
}
CS.yearsOf = yearsOf;

/* ---------------- search ---------------- */
CS.search = function (model, q, limit) {
  q = CS.normName(q);
  if (!q || q.length < 2) return [];
  const terms = q.split(' ').filter(Boolean);
  const out = [];
  const test = (name, maiden) => {
    const n = CS.normName(name) + ' ' + CS.normName(maiden || '');
    return terms.every(t => n.includes(t));
  };
  for (const m of model.memorials) {
    if (test(m.name, m.maiden)) { out.push({ kind: 'mem', item: m }); if (out.length >= (limit || 60)) return out; }
  }
  for (const r of model.roster) {
    if (r.mem) continue; // shown via memorial
    if (test(r.name, r.formerName)) { out.push({ kind: 'ros', item: r }); if (out.length >= (limit || 60)) return out; }
  }
  return out;
};

/* ---------------- imports ---------------- */
// Photo-request JSON from the bookmarklet (raw FAG ajax payload or already-array)
CS.parseRequestsJson = function (text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
  const arr = Array.isArray(data) ? data : (data.photoRequests || data.requests || null);
  if (!arr || !Array.isArray(arr)) return { error: 'JSON does not contain a photoRequests array.' };
  const requests = arr.map(r => ({
    prId: r.photoRequestId || r.prId || null,
    mid: +(r.memorialId || r.mid) || null,
    fn: r.firstName || r.fn || '', ln: r.lastName || r.ln || '',
    name: r.memorialName || r.name || ((r.firstName || '') + ' ' + (r.lastName || '')).trim(),
    by: r.birthYear || r.by || null, dy: r.deathYear || r.dy || null,
    bd: r.birthDate || r.bd || '', dd: r.deathDate || r.dd || '',
    plot: r.longPlot || r.plot || '', notes: r.notes || '',
    req: r.reqPublicName || r.req || '', created: r.dateCreated || r.created || '',
    lat: (r.latLonMethod === 'memorial' && r.latitude) ? +r.latitude : (r.lat != null ? r.lat : null),
    lng: (r.latLonMethod === 'memorial' && r.longitude) ? +r.longitude : (r.lng != null ? r.lng : null),
  })).filter(r => r.mid);
  return { requests };
};
// Official Download List file (rows from SheetJS: array of arrays or objects)
CS.parseRequestsSheet = function (rows) {
  if (!rows || !rows.length) return { error: 'Empty sheet.' };
  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const col = name => header.indexOf(name);
  const iMid = col('memorialid');
  if (iMid === -1) return { error: 'Not a Find a Grave photo-request export (no memorialId column).' };
  const idx = {
    fn: col('firstname'), ln: col('lastname'), bd: col('birthdate'), dd: col('deathdate'),
    lat: col('latitude'), lng: col('longitude'), plot: col('plot'), notes: col('notes'),
    created: col('datecreated'),
  };
  const yOf = s => { const m = String(s || '').match(/\b(1[6-9]\d\d|20\d\d)\b/); return m ? +m[1] : null; };
  const requests = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r[iMid]) continue;
    const lat = idx.lat >= 0 ? parseFloat(r[idx.lat]) : NaN;
    const lng = idx.lng >= 0 ? parseFloat(r[idx.lng]) : NaN;
    requests.push({
      prId: null, mid: +r[iMid],
      fn: idx.fn >= 0 ? String(r[idx.fn] || '') : '', ln: idx.ln >= 0 ? String(r[idx.ln] || '') : '',
      name: ((idx.fn >= 0 ? r[idx.fn] || '' : '') + ' ' + (idx.ln >= 0 ? r[idx.ln] || '' : '')).trim(),
      by: yOf(idx.bd >= 0 ? r[idx.bd] : ''), dy: yOf(idx.dd >= 0 ? r[idx.dd] : ''),
      bd: idx.bd >= 0 ? String(r[idx.bd] || '') : '', dd: idx.dd >= 0 ? String(r[idx.dd] || '') : '',
      plot: idx.plot >= 0 ? String(r[idx.plot] || '') : '', notes: idx.notes >= 0 ? String(r[idx.notes] || '') : '',
      req: '', created: idx.created >= 0 ? String(r[idx.created] || '') : '',
      lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null,
    });
  }
  return { requests };
};
// Memorial-index JSON from the bookmarklet: {records:[{memorialId,fullName,...}]} or compact rows
CS.parseMemorialsJson = function (text, cem) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
  const arr = data.records || data.collection || (Array.isArray(data) ? data : null);
  if (!arr) return { error: 'JSON has no records/collection array.' };
  const proj = CS.makeProj(cem);
  const memorials = [];
  for (const r of arr) {
    if (Array.isArray(r)) { memorials.push(r); continue; } // already compact
    if (!r.memorialId) continue;
    let lat = null, lng = null;
    if (r.latitude != null && r.longitude != null) {
      const en = proj.toEN(+r.latitude, +r.longitude);
      const d = Math.hypot(en.e, en.n);
      if (isFinite(d) && d >= 5 && d <= 500) { lat = +(+r.latitude).toFixed(6); lng = +(+r.longitude).toFixed(6); }
    }
    let flags = 0;
    if (r.intermentHasPhoto) flags |= 1;
    if (r.photoRequest) flags |= 2;
    if (r.isVeteran) flags |= 4;
    if (r.personHasPhoto) flags |= 8;
    memorials.push([r.memorialId, r.fullName || '', r.maidenName || '', r.birthYear || 0, r.deathYear || 0,
      (r.plot || '').replace(/\s+/g, ' ').trim(), lat, lng, flags]);
  }
  return { memorials };
};
// BS&A paste / clerk sheet -> roster rows
CS.parseRosterText = function (text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  let k = -1;
  for (const line of lines) {
    const s = line.trim();
    if (!s || s.length < 6) continue;
    const code = s.match(/\b([A-Z]+-\d+-[A-Z0-9]*-[A-Z0-9]*-?[0-9]*)\b/);
    const parsed = code ? CS.parseBsaCode(code[1]) : null;
    const nm = s.match(/^([A-Z][a-zA-Z'\-]+,\s*[A-Za-z'.\- ]+?)(?:\s{2,}|\t|$)/);
    let section = '', sub = '', block = '', lot = '', grave = '';
    if (parsed) ({ section, sub, block, lot, grave } = parsed);
    else {
      const p = CS.parsePlot(s);
      if (p) ({ section, sub, block, lot, grave } = p);
    }
    if (!nm && !parsed) continue;
    const name = nm ? nm[1].trim() : '';
    if (!name) continue;
    const years = [...s.matchAll(/\b(1[6-9]\d\d|20\d\d)\b/g)].map(m => +m[1]);
    rows.push([--k, name, '', years[0] ? String(years[0]) : '', years[1] ? String(years[1]) : '', '',
      section, sub, block, lot, grave, '', 0, '', '']);
  }
  return { roster: rows };
};
CS.parseRosterSheet = function (rows) {
  if (!rows || rows.length < 2) return { error: 'Empty sheet.' };
  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const find = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const iName = find('name', 'deceased', 'deceased name', 'full name', 'occupant');
  const iFirst = find('first name', 'firstname', 'first');
  const iLast = find('last name', 'lastname', 'last', 'surname');
  if (iName === -1 && (iFirst === -1 || iLast === -1)) return { error: 'No name column found.' };
  const iSec = find('section', 'sec'), iBlk = find('block', 'blk'), iLot = find('lot'), iGrv = find('grave', 'plot', 'space');
  const iPlotNo = find('plot number', 'plotnumber', 'plot #');
  const iBirth = find('birth date', 'birthdate', 'birth', 'born', 'dob');
  const iDeath = find('death date', 'deathdate', 'death', 'died', 'dod');
  const iBurial = find('burial date', 'burialdate', 'burial', 'interment date');
  const out = [];
  let k = -1000;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const name = iName >= 0 ? String(r[iName] || '').trim()
      : (String(r[iLast] || '').trim() + ', ' + String(r[iFirst] || '').trim()).replace(/^, |, $/g, '');
    if (!name) continue;
    let section = '', sub = '', block = '', lot = '', grave = '';
    if (iPlotNo >= 0 && r[iPlotNo]) {
      const p = CS.parseBsaCode(String(r[iPlotNo]).trim());
      if (p) ({ section, sub, block, lot, grave } = p);
    }
    if (!section && iSec >= 0) {
      const raw = String(r[iSec] || '').trim();
      const canon = BSA_SECTION[raw] || BSA_SECTION[raw.replace(/^0/, '')];
      if (canon) { section = canon[0]; sub = canon[1]; }
      else { const p = CS.parsePlot(raw + ' Lot 0'); section = p ? p.section : raw; }
      block = iBlk >= 0 ? String(r[iBlk] || '').trim().toUpperCase() : '';
      lot = iLot >= 0 ? String(r[iLot] || '').trim().replace(/^0+(?=\d)/, '') : '';
      grave = iGrv >= 0 ? String(r[iGrv] || '').trim() : '';
    }
    out.push([--k, name, '', iBirth >= 0 ? String(r[iBirth] || '') : '', iDeath >= 0 ? String(r[iDeath] || '') : '',
      iBurial >= 0 ? String(r[iBurial] || '') : '', section, sub, block, lot, grave, '', 0, '', '']);
  }
  return { roster: out };
};

/* ---------------- bookmarklets ---------------- */
CS.bookmarklets = function (cemeteryId) {
  const reqSrc = "javascript:(async()=>{try{const r=await fetch('/photo-request/search/cemetery/" + cemeteryId + "?ajax=true&skip=0&limit=1000',{headers:{Accept:'application/json'}});const j=await r.json();const t=JSON.stringify(j.photoRequests||[]);await navigator.clipboard.writeText(t);alert('Copied '+(j.photoRequests||[]).length+' photo requests. Paste into Cemetery Search.');}catch(e){alert('Failed: '+e.message+' — open this on findagrave.com');}})();";
  // NOTE: javascript: URLs are percent-decoded on click — the source must not contain
  // a raw '%' followed by hex digits (so no modulo operators in these snippets).
  const memSrc = "javascript:(async()=>{try{let all=[],skip=0,total=1;while(skip<total){const r=await fetch('/cemetery/" + cemeteryId + "/memorial-search?ajax=true&limit=100&skip='+skip,{headers:{Accept:'application/json'}});const j=await r.json();total=j.total;all=all.concat(j.collection||[]);skip+=100;document.title='Cemetery grab '+skip+'/'+total;await new Promise(s=>setTimeout(s,350));}const slim=all.map(m=>({memorialId:m.memorialId,fullName:m.fullName,maidenName:m.maidenName,birthYear:m.birthYear,deathYear:m.deathYear,plot:m.plot,latitude:m.latitude,longitude:m.longitude,intermentHasPhoto:m.intermentHasPhoto,personHasPhoto:m.personHasPhoto,photoRequest:m.photoRequest,isVeteran:m.isVeteran}));await navigator.clipboard.writeText(JSON.stringify({records:slim}));alert('Copied '+slim.length+' memorials ('+Math.round(JSON.stringify(slim).length/1024)+' KB). Paste into Cemetery Search.');}catch(e){alert('Failed: '+e.message+' — open this on findagrave.com');}})();";
  for (const src of [reqSrc, memSrc]) {
    if (/%[0-9a-fA-F]/.test(src)) throw new Error('bookmarklet contains raw % escape — would break on URL decode');
  }
  return { requests: reqSrc, memorials: memSrc };
};

/* ---------------- exports ---------------- */
if (typeof module !== 'undefined' && module.exports) module.exports = CS;
else root.CS = CS;
})(typeof window !== 'undefined' ? window : globalThis);
