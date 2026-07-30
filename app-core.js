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
// profile: 'oakgrove' applies Oak Grove's section-name aliases (Section 11 = Square
// Hill etc). Every other cemetery MUST use 'generic' — the aliases would corrupt
// their plots. Requests and anchors go through the same parser, so what matters
// most is CONSISTENT keys, not perfect semantics.
CS.parsePlot = function (plotStr, profile) {
  if (!plotStr) return null;
  const s = String(plotStr).replace(/[().,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /no location|unknown|pottersfield|interment record only/i.test(s)) return null;

  if (profile === 'oakgrove') {
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
  }

  /* generic profile */
  let sub = (s.match(/\bSub\.?\s*:?\s*(\d+)\b/i) || [])[1] || '';
  let block = normBlock((s.match(/\b(?:Blk|Block|Row)[\s\-:#]*([A-Z]{1,2}|\d{1,3}[A-Z]?)\b/i) || [])[1] || '');
  let lot = (s.match(/\bLot[\s\-:#]*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  let grave = (s.match(/\b(?:Grave|Space|Sp)[\s\-:#]*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  const plotTok = (s.match(/\bPlot[\s\-:#]*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  if (plotTok) {
    if (!grave) grave = plotTok;       // "Plot 3" usually means the grave slot…
    else if (!lot) lot = plotTok;      // …but with an explicit Grave present it's the lot
  }
  let section = '';
  const secm = s.match(/\bSec(?:t?ion)?[\s\-.:#]*([A-Za-z0-9]+)\b/i);
  if (secm && !/^(lot|blk|block|row|grave|space)$/i.test(secm[1])) section = 'Section ' + secm[1].toUpperCase();
  if (!section) {
    const lead = s.match(/^(.*?)\s*\b(?:Blk|Block|Row|Sub|Lot|Grave|Space|Sp)\b/i);
    if (lead) {
      // strip record-id noise ("ID 1849", "#123", bare long numbers) — they would
      // make every section key unique and kill all anchor matching
      const cleaned = lead[1].replace(/\b(?:id|no)\s*#?\s*\d+\b/ig, '').replace(/\b\d{3,}\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (cleaned.length > 1 && !/^\d+$/.test(cleaned)) section = cleaned;
    }
  }
  if (!section && !block && !lot && !grave) {
    // dash-coded plots, e.g. "Ithaca-2nd ADD-31--2" or "CEM-SEC-BLK-LOT-GRV"
    const dash = s.split(/\s*-\s*/);
    if (dash.length >= 4) {
      section = dash[1] || '';
      block = normBlock(dash[2] || '');
      lot = (dash[3] || '').replace(/^0+(?=\d)/, '');
      grave = dash[4] || '';
      // "CEM-SECTION-LOT-<half>-GRAVE": an empty or half-lot 4th field
      // ("N 1/2", "S. 1/2") means the 3rd field was the LOT, not a block —
      // Ithaca's city register is written this way
      if (!lot || /^[NSEW]\.?\s*\d\/\d$/i.test(lot)) {
        lot = block;
        block = '';
      }
    } else {
      // terse codes: "12B", "12-B", bare block letter "A"
      let m = s.match(/^(\d{1,4})\s*-?\s*([A-Za-z])$/);
      if (m) { section = '*'; lot = m[1]; grave = m[2].toUpperCase(); }
      else if (/^[A-Za-z]{1,2}$/.test(s)) { section = '*'; block = s.toUpperCase(); }
      else if (/^\d{1,4}$/.test(s)) { section = '*'; lot = s; }
      // a bare section name ("New Addition", "East Side") still buckets anchors usefully
      else if (/^[A-Za-z][A-Za-z .'&]{2,29}$/.test(s) && !/^(unknown|none|n\/?a)$/i.test(s)) section = s.trim();
      else return null;
    }
  }
  if (!section && (block || lot || grave)) section = '*';
  if (!section) return null;
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
  // the section-code table is Oak Grove's — other cemeteries keep numeric sections
  const isOakGrove = /^OAKGROVE$/i.test(m[1]);
  const canon = isOakGrove ? (BSA_SECTION[m[2]] || BSA_SECTION[m[2].replace(/^0/, '')]) : null;
  return {
    section: canon ? canon[0] : ('Section ' + m[2].replace(/^0+(?=\d)/, '')),
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
  jennie:'jane', jenny:'jane', jerry:'gerald', jim:'james', jimmy:'james', jno:'john', johann:'john', joe:'joseph',
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
  // parentheticals ("SMITH, MARY (BAKER??)") poison first-name comparison
  const s = String(full || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
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
// Wraps a v2 multi-cemetery dataset (window.CEMDATA) or a legacy single-cemetery
// one (window.OAKGROVE) into a list of per-cemetery descriptors.
CS.normalizeDataset = function (raw) {
  if (raw && raw.v === 2 && Array.isArray(raw.cemeteries)) {
    return {
      generated: raw.generated || '',
      home: raw.home,
      radiusMiles: raw.radiusMiles || null,
      cemeteries: raw.cemeteries.map(c => ({
        id: c.id, name: c.name || ('Cemetery ' + c.id), county: c.county || '',
        miles: c.miles != null ? c.miles : null, bsaUid: c.bsaUid || null,
        contact: c.contact || '',
        data: {
          meta: {
            cemetery: c.name, fagCemeteryId: c.id,
            cem: { lat: c.lat, lng: c.lng },
            declination: c.declination != null ? c.declination : -6.6,
            asOf: (c.meta && (c.meta.memorialsAsOf || c.meta.asOf)) || raw.generated || '',
          },
          sections: c.sections || {},
          maps: c.maps || [],
          sgBlocks: c.sgBlocks || [],
          rosterAsOf: c.rosterAsOf || null,
          grounds: c.grounds || null,
          requests: c.requests || [],
          memorials: c.memorials || [],
          roster: c.roster || [],
        },
      })),
    };
  }
  if (raw && raw.meta) { // legacy OAKGROVE shape
    return {
      generated: raw.meta.asOf || '', home: raw.meta.cem, radiusMiles: null,
      cemeteries: [{
        id: raw.meta.fagCemeteryId || 0, name: raw.meta.cemetery || 'Cemetery',
        county: '', miles: 0, bsaUid: 2024, data: raw,
      }],
    };
  }
  return { generated: '', home: { lat: 43.4202995, lng: -84.6136017 }, radiusMiles: null, cemeteries: [] };
};

// Builds the unified in-memory model from one cemetery's dataset + user updates.
CS.buildModel = function (data, updates) {
  updates = updates || {};
  const model = {
    meta: data.meta,
    proj: CS.makeProj(data.meta.cem),
    sections: Object.assign({}, data.sections || {}),
    maps: data.maps || [],
    memorials: [],
    memById: new Map(),
    roster: [],
    requests: [],
    plotIndex: new Map(),   // "section|sub|block" -> [entries {who}]
    anchorIndex: new Map(), // "section|sub|block|lot" -> [{e,n}] from GPS-tagged memorials
  };

  const profile = (data.meta && data.meta.fagCemeteryId === 1252) ? 'oakgrove' : 'generic';
  model.profile = profile;
  model.rosterAsOf = data.rosterAsOf || null;

  /* memorials: baked, then overlay updates (by id) */
  const memRows = new Map();
  for (const m of (data.memorials || [])) memRows.set(m[0], m);
  for (const m of (updates.memorials || [])) memRows.set(m[0], m);
  for (const row of memRows.values()) {
    const [midRaw, name, maiden, by, dy, plot, lat, lng, flags, famRaw] = row;
    const mid = +midRaw || null;
    if (!mid) continue;
    const p = CS.parsePlot(plot, profile);
    const sn = CS.splitName(name && name.includes(',') ? name : nameFromFag(name));
    const mem = {
      kind: 'mem', mid, name, maiden: maiden || '', by: by || 0, dy: dy || 0,
      plot: plot || '', p, lat: lat != null ? lat : null, lng: lng != null ? lng : null,
      hasGravePhoto: !!(flags & 1), hasRequest: !!(flags & 2), veteran: !!(flags & 4),
      last: sn.last, first: sn.first,
      // normalized keys cached once — scorePair/search must never re-normalize per pair
      nl: CS.normName(sn.last), sx: CS.soundex(sn.last),
      nm: maiden ? CS.normName(maiden) : '',
      cf: CS.canonFirst(sn.first), fr: CS.normName(sn.first).split(' ')[0] || '',
      sk: CS.normName(name) + (maiden ? ' ' + CS.normName(maiden) : ''),
      dyb: false,
      fam: famRaw ? String(famRaw).split('|').filter(Boolean) : [],
    };
    model.memorials.push(mem);
    model.memById.set(mid, mem);
  }
  function nameFromFag(n) { return n; } // FAG fullName is "First Middle Last"

  /* roster */
  const sgBlocks = new Set(data.sgBlocks || []);
  for (const row of ((updates.roster && updates.roster.length ? updates.roster : data.roster) || [])) {
    const [key, name, sex, bd, dd, burial, section, sub, block, lot, grave, status, flags, note, formerName] = row;
    const sn = CS.splitName(name);
    const yOf = s => { const m = String(s || '').match(/\b(1[6-9]\d\d|20\d\d)\b/); return m ? +m[1] : 0; };
    let rLot = String(lot || ''), rGrave = String(grave || '');
    // Single Grave: BS&A stores the cell number in the grave field (OAKGROVE-14-{row}--{cell})
    if (section === 'Single Grave' && !rLot && rGrave) { rLot = rGrave; rGrave = ''; }
    // grave-numbered blocks (declared by the cemetery's geometry, e.g. Riverside
    // R/MAUSO): the lot column is a constant and the grave number is the position
    if (sgBlocks.has(normBlock(block)) && rGrave && (!rLot || rLot === '1')) { rLot = rGrave; rGrave = ''; }
    // generic cemeteries: numeric register sections align with parsed "Section N";
    // a sectionless register row with block/lot still keys to the '*' bucket
    let rSection = section || '';
    if (profile !== 'oakgrove') {
      if (/^\d+$/.test(rSection)) rSection = 'Section ' + rSection.replace(/^0+(?=\d)/, '');
      else if (!rSection && (block || rLot)) rSection = '*';
    }
    const fmr = formerName ? CS.splitName(formerName) : null;
    model.roster.push({
      kind: 'ros', key, name, sex: sex || '', bd: bd || '', dd: dd || '', burial: burial || '',
      by: yOf(bd), dy: yOf(dd) || yOf(burial),
      section: rSection, sub: sub || '', block: normBlock(block),
      lot: rLot, grave: rGrave,
      status: status || '', veteran: !!(flags & 4), note: note || '', formerName: formerName || '',
      last: sn.last, first: sn.first,
      nl: CS.normName(sn.last), sx: CS.soundex(sn.last),
      nm: fmr ? CS.normName(fmr.last || formerName) : '',
      cf: CS.canonFirst(sn.first), fr: CS.normName(sn.first).split(' ')[0] || '',
      sk: CS.normName(name) + (formerName ? ' ' + CS.normName(formerName) : ''),
      dyb: !yOf(dd) && !!yOf(burial), // "death year" actually came from the burial date
    });
  }

  /* field-confirmed GPS: the user stood at the stone and saved a fix — the
     best evidence there is. The pin becomes the person's own position (so
     search/map/guide all use it) and, via plot parsing, an anchor that
     improves locate for everyone in the same lot and block. */
  const fieldGps = updates.fieldGps || {};
  const cemHome = data.meta && data.meta.cem;
  for (const [pk, g] of Object.entries(fieldGps)) {
    if (!g || g.lat == null || g.lng == null) continue;
    if (cemHome && CS.distM(g.lat, g.lng, cemHome.lat, cemHome.lng) > 800) continue; // wrong-cemetery guard
    if (pk.startsWith('ros:')) {
      const key = pk.slice(4);
      const r = model.roster.find(x => String(x.key) === key);
      if (r) r.fieldGps = g;
    } else {
      const mem = model.memById.get(+pk);
      if (mem) { mem.fieldGps = g; mem.lat = g.lat; mem.lng = g.lng; }
    }
  }

  /* requests: updates replace baked entirely (a refresh is a full snapshot) */
  // Array.isArray (not length) so an imported EMPTY snapshot legitimately clears requests
  const reqRows = (Array.isArray(updates.requests) ? updates.requests : data.requests) || [];
  for (const r of reqRows) {
    const mid = +r.mid || null;
    if (!mid) continue;
    const fn = r.fn || '', ln = r.ln || '';
    model.requests.push({
      kind: 'req',
      prId: r.prId, mid, name: r.name || (fn + ' ' + ln).trim(),
      fn, ln, by: r.by || null, dy: r.dy || null,
      bd: r.bd || '', dd: r.dd || '', plot: r.plot || '', notes: r.notes || '',
      req: r.req || '', created: r.created || '',
      claimed: r.claimed || '', problem: r.problem || '',
      lat: r.lat != null ? r.lat : null, lng: r.lng != null ? r.lng : null,
      p: CS.parsePlot(r.plot, profile),
      nl: CS.normName(ln), sx: CS.soundex(ln), nm: '',
      cf: CS.canonFirst(fn), fr: CS.normName(fn).split(' ')[0] || '',
      dyb: false, section: '', block: '', lot: '',
    });
  }

  dropOutOfBounds(model, data.grounds);   // before anything consumes the maps
  buildPlotIndex(model);
  buildAnchorIndex(model);
  matchRosterToMemorials(model);
  addRosterAnchors(model);   // register position × matched memorial GPS
  fitWalkRows(model);        // live row-line fits — every saved pin re-fits
  deriveSections(model);
  for (const req of model.requests) enrichRequest(model, req);
  return model;
};

/* GPS-tagged memorials with parsed plots become location anchors: the proven
   field fact is that a same-lot anchor predicts a grave within ~2-5 m. */
function buildAnchorIndex(model) {
  const seenCoord = new Map(); // dedupe bulk-pinned families (same exact coordinate)
  for (const m of model.memorials) {
    if (m.lat == null || m.lng == null || !m.p || !m.p.section) continue;
    const en = model.proj.toEN(m.lat, m.lng);
    const ck = m.lat.toFixed(6) + ',' + m.lng.toFixed(6);
    const w = seenCoord.has(ck) ? 0 : 1;
    seenCoord.set(ck, true);
    if (!w) continue;
    const k = m.p.section + '|' + (m.p.sub || '') + '|' + (m.p.block || '') + '|' + (parseInt(m.p.lot) || m.p.lot || '');
    if (!model.anchorIndex.has(k)) model.anchorIndex.set(k, []);
    model.anchorIndex.get(k).push({ e: en.e, n: en.n });
  }
  // field-confirmed pins on register-only people: their plot buckets get an
  // anchor even though no memorial carries the coordinates
  for (const r of model.roster) {
    const g = r.fieldGps;
    if (!g || !r.section) continue;
    const en = model.proj.toEN(g.lat, g.lng);
    const k = r.section + '|' + (r.sub || '') + '|' + (r.block || '') + '|' + (parseInt(r.lot) || r.lot || '');
    if (!model.anchorIndex.has(k)) model.anchorIndex.set(k, []);
    model.anchorIndex.get(k).push({ e: en.e, n: en.n });
  }
}

/* Walk-order registers record section-row-position in physical walk order,
   and cemetery rows are straight lines — so a least-squares line through a
   row's GPS-anchored members places EVERYONE registered in that row. Runs at
   every model build, so a field-saved pin refits its row in real time.
   Gates keep it honest: plausible stone spacing, anchors must agree with a
   straight line, and placement stays within the anchored span (+ a short
   extension). Skips positions a real plat map already draws. */
function fitWalkRows(model) {
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const staticKeys = new Set();
  for (const m of model.maps) {
    for (const e of m.entries) staticKeys.add(m.section + '|' + e[0] + '|' + e[1]);
  }
  const rows = new Map();
  for (const r of model.roster) {
    const pos = parseInt(r.lot);
    if (!r.section || !r.block || !isFinite(pos)) continue;
    const k = r.section + '|' + r.block;
    if (!rows.has(k)) rows.set(k, { section: r.section, row: r.block, anchors: new Map(), members: new Set() });
    const R = rows.get(k);
    R.members.add(pos);
    let en = null;
    if (r.fieldGps) en = model.proj.toEN(r.fieldGps.lat, r.fieldGps.lng);
    else if (r.mem && r.mem.lat != null) en = model.proj.toEN(r.mem.lat, r.mem.lng);
    if (en) {
      if (!R.anchors.has(pos)) R.anchors.set(pos, []);
      R.anchors.get(pos).push(en);
    }
  }
  const bySection = new Map();
  const resids = [];
  for (const R of rows.values()) {
    const pts = [...R.anchors.entries()].map(([pos, list]) => ({
      pos,
      e: list.reduce((s, x) => s + x.e, 0) / list.length,
      n: list.reduce((s, x) => s + x.n, 0) / list.length,
    }));
    if (pts.length < 2) continue;
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
    if (step < 0.5 || step > 5) continue;
    const rowResid = pts.map(p => Math.hypot(fe.icept + fe.slope * p.pos - p.e, fn.icept + fn.slope * p.pos - p.n));
    if (pts.length >= 3 && med(rowResid) > 8) continue;
    resids.push(...rowResid);
    const aMin = Math.min(...pts.map(p => p.pos)), aMax = Math.max(...pts.map(p => p.pos));
    const ext = Math.min(6, Math.max(2, aMax - aMin));
    if (!bySection.has(R.section)) bySection.set(R.section, []);
    const entries = bySection.get(R.section);
    for (const pos of R.members) {
      if (pos < aMin - ext || pos > aMax + ext) continue;
      if (staticKeys.has(R.section + '|' + R.row + '|' + pos)) continue;
      entries.push([R.row, String(pos),
        Math.round((fe.icept + fe.slope * pos) * 100) / 100,
        Math.round((fn.icept + fn.slope * pos) * 100) / 100]);
    }
  }
  if (!bySection.size) return;
  const looMedian = Math.round((resids.length ? med(resids) : 6) * 10) / 10;
  const quality = looMedian <= 4 ? 'fair' : 'approx';
  for (const [section, entries] of bySection) {
    if (!entries.length) continue;
    model.maps.push({
      file: 'walk-order-rows', dynamic: true, section, sub: '', style: 'rows',
      page: { w: 0, h: 0 },
      transform: { a: 1, b: 0, c: 0, d: 0, f: 1, g: 0 },   // entries are local meters
      quality, looMedian, entries,
    });
  }
}
CS.fitWalkRows = fitWalkRows;

/* Register rows matched to GPS-tagged memorials cross-multiply: the register
   says where the grave sits in the cemetery's own scheme, the photo says
   where that is on Earth — together they anchor the whole row/lot, which is
   how register-only cemeteries (no plat, no FAG plots) become navigable. */
function addRosterAnchors(model) {
  const seen = new Set();
  for (const r of model.roster) {
    const m = r.mem;
    if (!m || m.lat == null || m.lng == null || !r.section) continue;
    const k = r.section + '|' + (r.sub || '') + '|' + (r.block || '') + '|' + (parseInt(r.lot) || r.lot || '');
    const mk = m.p && m.p.section
      ? m.p.section + '|' + (m.p.sub || '') + '|' + (m.p.block || '') + '|' + (parseInt(m.p.lot) || m.p.lot || '')
      : null;
    if (k === mk) continue;                        // already anchored by the memorial's own plot
    const ck = k + '@' + m.lat.toFixed(6) + ',' + m.lng.toFixed(6);
    if (seen.has(ck)) continue;
    seen.add(ck);
    const en = model.proj.toEN(m.lat, m.lng);
    if (!model.anchorIndex.has(k)) model.anchorIndex.set(k, []);
    model.anchorIndex.get(k).push({ e: en.e, n: en.n });
  }
}

/* For cemeteries without baked section centroids, derive them from anchors. */
function deriveSections(model) {
  if (Object.keys(model.sections).length) return;
  const bySec = new Map();
  for (const [k, pts] of model.anchorIndex) {
    const sec = k.split('|')[0];
    if (!bySec.has(sec)) bySec.set(sec, []);
    bySec.get(sec).push(...pts);
  }
  for (const [sec, pts] of bySec) {
    if (pts.length < 3) continue;
    const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const ce = med(pts.map(p => p.e)), cn = med(pts.map(p => p.n));
    const ll = model.proj.toLL(ce, cn);
    // honest section radius: 80th-percentile anchor distance from the centroid
    const dists = pts.map(p => Math.hypot(p.e - ce, p.n - cn)).sort((a, b) => a - b);
    const p80 = dists[Math.floor(0.8 * (dists.length - 1))];
    model.sections[sec] = {
      lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6),
      anchors: pts.length, derived: true,
      radius: Math.round(Math.min(160, Math.max(30, p80))),
    };
  }
}

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

/* A drawn lot outside the cemetery grounds is wrong by definition — a plat
   fit extrapolated past its evidence. Rather than send someone into the
   trees, drop those entries at model build. The margin is generous because
   OSM boundaries are rough: only clearly-outside positions go. */
const BOUNDS_MARGIN_M = 25;
function distToPolyM(lat, lng, poly, proj) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((xi > lng) !== (xj > lng) && lat < (yj - yi) * (lng - xi) / (xj - xi) + yi) inside = !inside;
  }
  if (inside) return 0;
  const p = proj.toEN(lat, lng);
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = proj.toEN(poly[j][0], poly[j][1]);
    const b = proj.toEN(poly[i][0], poly[i][1]);
    const vx = b.e - a.e, vy = b.n - a.n;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((p.e - a.e) * vx + (p.n - a.n) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.e - (a.e + t * vx), p.n - (a.n + t * vy));
    if (d < best) best = d;
  }
  return best;
}
function dropOutOfBounds(model, grounds) {
  const polys = (grounds && grounds.bounds) || [];
  if (!polys.length) return;
  let dropped = 0;
  for (const m of model.maps) {
    if (!m.transform || !m.entries || !m.entries.length) continue;
    m.entries = m.entries.filter(e => {
      const w = applyT(m.transform, e[2], e[3]);
      const ll = model.proj.toLL(w.e, w.n);
      if (!isFinite(ll.lat)) return false;
      let dmin = Infinity;
      for (const poly of polys) {
        dmin = Math.min(dmin, distToPolyM(ll.lat, ll.lng, poly, model.proj));
        if (dmin <= BOUNDS_MARGIN_M) return true;
      }
      dropped++;
      return false;
    });
  }
  model.outOfBounds = dropped;
}

/* Everyone recorded in one drawn lot — memorials and register rows, deduped
   where they're the same person. Lets the map answer "who is buried here?"
   for any lot number you can see. */
CS.lotOccupants = function (model, section, sub, block, lot) {
  if (!section) return [];
  const all = model.plotIndex.get(plotKey(section, sub, block)) || [];
  const want = String(parseInt(lot));
  const out = [];
  const seen = new Set();
  for (const { p: q, who } of all) {
    if (String(parseInt(q.lot)) !== want) continue;
    if (block && q.block && normBlock(q.block) !== normBlock(block)) continue;
    if (who.kind === 'ros' && who.mem) continue;            // shown via the memorial
    const key = who.kind === 'mem' ? 'm' + who.mid : 'r' + who.key;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ who, grave: q.grave || '' });
  }
  out.sort((a, b) => (parseInt(a.grave) || 99) - (parseInt(b.grave) || 99));
  return out;
};

/* roster <-> memorial matching */
function matchRosterToMemorials(model) {
  const byLast = new Map();
  const add = (k, m) => { if (!byLast.has(k)) byLast.set(k, []); byLast.get(k).push(m); };
  for (const m of model.memorials) {
    add('n:' + m.nl, m);
    add('s:' + m.sx, m);
    if (m.nm) add('n:' + m.nm, m);
  }
  for (const r of model.roster) {
    const cands = new Set();
    for (const m of (byLast.get('n:' + r.nl) || [])) cands.add(m);
    for (const m of (byLast.get('s:' + r.sx) || [])) cands.add(m);
    if (r.nm) for (const m of (byLast.get('n:' + r.nm) || [])) cands.add(m);
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
  // era-gated fallback for dateless registers (e.g. a 1941 sexton book): a
  // row with no dates may claim its unique full-name match among memorials
  // who died within the register's era — uniqueness plus the era cap keep a
  // later burial of the same name from being grabbed.
  const asOf = model.rosterAsOf;
  if (asOf) {
    for (const r of model.roster) {
      if (r.mem || r.by || r.dy || !r.cf) continue;
      const cands = [...new Set(byLast.get('n:' + r.nl) || [])]
        .filter(m => !m.ros && m.dy && m.dy <= asOf && m.cf &&
                     (m.cf === r.cf || (m.fr && m.fr === r.fr)));
      if (cands.length === 1) {
        r.mem = cands[0];
        cands[0].ros = r; cands[0].rosScore = 60;
      }
    }
  }
}
// small Levenshtein bound check (<=2 edits) for spelling variants like Mabel/Mable
function lev2(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return false;
  const prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 2) return false;
    for (let j = 0; j <= lb; j++) prev[j] = cur[j];
  }
  return prev[lb] <= 2;
}
// r and m must both carry cached keys (nl, sx, nm?, cf, fr, by, dy, dyb)
function scorePair(r, m) {
  let s = 0;
  if (r.nl && (r.nl === m.nl || (m.nm && r.nl === m.nm) || (r.nm && r.nm === m.nl))) s += 30;
  else if (r.sx === m.sx) s += 18;
  else return 0;
  const rfRaw = r.fr, mfRaw = m.fr;
  if (r.cf && m.cf) {
    if (r.cf === m.cf || rfRaw === mfRaw) s += 30;
    else if (rfRaw && mfRaw && (rfRaw.startsWith(mfRaw) || mfRaw.startsWith(rfRaw))) s += 20;
    else if (rfRaw.length >= 4 && mfRaw.length >= 4 && rfRaw[0] === mfRaw[0] && lev2(rfRaw, mfRaw)) s += 22; // spelling variants
    else if (rfRaw.length === 1 || mfRaw.length === 1) { if (rfRaw[0] === mfRaw[0]) s += 6; }
    else if (rfRaw[0] === mfRaw[0]) s += 2;
    else s -= 40; // contradicting full first names: almost certainly a different person (spouse trap)
  }
  // years — soften when either side's death year is really a burial year (reinterments)
  const soft = r.dyb || m.dyb;
  if (r.by && m.by) {
    const d = Math.abs(r.by - m.by);
    s += d === 0 ? 25 : d <= 1 ? 15 : d <= 3 ? 2 : -20;
  }
  if (r.dy && m.dy) {
    const d = Math.abs(r.dy - m.dy);
    s += d === 0 ? (soft ? 18 : 25) : d <= 1 ? (soft ? 12 : 15) : d <= 3 ? 2 : (soft ? -8 : -20);
  }
  // plot agreement — '*' means "no section info", never evidence either way
  if (r.section && r.section !== '*' && m.p && m.p.section && m.p.section !== '*') {
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
function anchorCluster(pts) {
  if (!pts || !pts.length) return null;
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  let e = med(pts.map(q => q.e)), n = med(pts.map(q => q.n));
  let kept = pts.filter(q => Math.hypot(q.e - e, q.n - n) <= 25);
  if (!kept.length) kept = pts;
  e = med(kept.map(q => q.e)); n = med(kept.map(q => q.n));
  const spread = Math.sqrt(kept.reduce((s, q) => s + ((q.e - e) ** 2 + (q.n - n) ** 2), 0) / kept.length);
  return { e, n, spread, count: kept.length };
}
function anchorLocate(model, p, lotNum) {
  const base = p.section + '|' + (p.sub || '') + '|' + (p.block || '') + '|';
  // exact lot — only when the query actually HAS a lot (an empty lot would match the
  // whole lot-less bucket and masquerade as a lot-level fix)
  const exact = (isFinite(lotNum) || p.lot) ? model.anchorIndex.get(base + (isFinite(lotNum) ? lotNum : p.lot)) : null;
  if (exact && exact.length) {
    const c = anchorCluster(exact);
    const ll = model.proj.toLL(c.e, c.n);
    // one lone pin deserves less confidence than several agreeing family stones
    const floor = c.count === 1 ? 10 : 6;
    return { ...ll, acc: Math.round(Math.min(18, Math.max(floor, floor + c.spread / 2))), level: 'lot', map: null, xy: null, src: 'anchors', pins: c.count };
  }
  // adjacent numeric lots in the same block
  if (isFinite(lotNum)) {
    const near = [];
    let pinCount = 0;
    for (let d = 1; d <= 3; d++) {
      for (const l of [lotNum - d, lotNum + d]) {
        const pts = model.anchorIndex.get(base + l);
        if (pts) { const c = anchorCluster(pts); near.push({ c, w: 1 / (1 + d) }); pinCount += c.count; }
      }
      if (near.length >= 2) break;
    }
    if (near.length) {
      let se = 0, sn = 0, sw = 0;
      for (const { c, w } of near) { se += c.e * w; sn += c.n * w; sw += w; }
      const ll = model.proj.toLL(se / sw, sn / sw);
      return { ...ll, acc: pinCount > 1 ? 14 : 17, level: 'adjacent', map: null, xy: null, src: 'anchors', pins: pinCount };
    }
  }
  // block cluster
  if (p.block) {
    const pts = [];
    for (const [k, v] of model.anchorIndex) if (k.startsWith(base)) pts.push(...v);
    if (pts.length >= 2) {
      const c = anchorCluster(pts);
      const ll = model.proj.toLL(c.e, c.n);
      return { ...ll, acc: Math.round(Math.min(45, Math.max(18, 15 + c.spread / 2))), level: 'block', map: null, xy: null, src: 'anchors', pins: c.count };
    }
  }
  return null;
}

CS.locate = function (model, p) {
  // p: {section, sub, block, lot, grave}; returns {lat,lng,acc,level,map,xy} or null
  if (!p || !p.section) return null;
  const maps = model.maps.filter(m => m.section === p.section && (p.section !== 'Old Part' || !p.sub || m.sub === p.sub));
  const lotNum = parseInt(p.lot);
  const anchors = { lot: null, computed: false };
  const anchorsAt = () => {
    if (!anchors.computed) { anchors.lot = anchorLocate(model, p, lotNum); anchors.computed = true; }
    return anchors.lot;
  };
  // exact lot entry
  for (const m of maps) {
    if (!m.transform) continue;
    const hits = m.entries.filter(e => (!p.block || e[0] === p.block || m.style === 'lots') &&
      String(e[1]) === String(isFinite(lotNum) ? lotNum : p.lot) &&
      (m.style !== 'lots' || !p.block || true));
    let hit = hits.length === 1 ? hits[0] : null;
    if (!hit && hits.length > 1 && p.block) {
      const bh = hits.filter(e => e[0] === p.block);
      if (bh.length === 1) hit = bh[0];
    }
    if (hit) {
      const ll = applyT(m.transform, hit[2], hit[3]);
      const fix = { ...model.proj.toLL(ll.e, ll.n), acc: qualityAcc(m, 'lot'), level: 'lot', map: m, xy: [hit[2], hit[3]] };
      // sanity: if same-lot GPS pins disagree with the plat position by a lot,
      // keep the map fix but say so — the volunteer should check both spots
      const a = anchorsAt();
      if (a && a.level === 'lot' && CS.distM(fix.lat, fix.lng, a.lat, a.lng) > 25) fix.disputed = true;
      return fix;
    }
  }
  // same-lot GPS anchors beat everything except a drawn map lot
  { const a = anchorsAt(); if (a && a.level === 'lot') return a; }
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
  // near-lot anchors
  { const a = anchorsAt(); if (a && a.level === 'adjacent') return a; }
  // block centroid from the plat map
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
  // block-level anchor cluster
  { const a = anchorsAt(); if (a) return a; }
  // section centroid — accuracy from the section's real anchor spread when known
  const sec = model.sections[p.section];
  if (sec) return { lat: sec.lat, lng: sec.lng, acc: sec.radius || 45, level: 'section', map: null, xy: null };
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
  req.rosScore = req.ros && mem ? (mem.rosScore || 0) : 0;
  if (!req.ros) {
    let best = null, bestScore = 0;
    for (const r of model.roster) {
      if (r.nl !== req.nl && r.sx !== req.sx) continue;
      const s = scorePair(req, { nl: r.nl, sx: r.sx, nm: r.nm, cf: r.cf, fr: r.fr, by: r.by, dy: r.dy, dyb: r.dyb, p: null });
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (best) {
      // relaxed acceptance when identity is unambiguous (exact names, no contradicting year)
      const exactNames = best.nl === req.nl && (best.cf === req.cf || best.fr === req.fr) && req.fr;
      const yearsOk = !(req.dy && best.dy && Math.abs(req.dy - best.dy) > 3) &&
                      !(req.by && best.by && Math.abs(req.by - best.by) > 3);
      if (bestScore >= 70 || (bestScore >= 58 && exactNames && yearsOk)) {
        req.ros = best;
        req.rosScore = bestScore;
      }
    }
  }
  req.rosVerify = !!(req.ros && req.rosScore > 0 && req.rosScore < 85);
  // best plot info: locate BOTH sources and keep whichever resolves more precisely
  req.pFag = req.p;
  req.pRos = req.ros && req.ros.section ? { section: req.ros.section, sub: req.ros.sub, block: req.ros.block, lot: req.ros.lot, grave: req.ros.grave } : null;
  // '*' is the "no section info" sentinel — never a disagreement by itself
  req.plotConflict = !!(req.pFag && req.pRos && req.pFag.section && req.pRos.section &&
    ((req.pFag.section !== req.pRos.section && req.pFag.section !== '*' && req.pRos.section !== '*') ||
     (req.pFag.sub && req.pRos.sub && req.pFag.sub !== req.pRos.sub) ||
     (req.pFag.block && req.pRos.block && req.pFag.block !== req.pRos.block) ||
     (req.pFag.lot && req.pRos.lot && isFinite(+req.pFag.lot) && isFinite(+req.pRos.lot) && String(+req.pFag.lot) !== String(+req.pRos.lot))));
  // location cascade — request GPS first, but ONLY if it isn't a junk pin sitting
  // exactly on the cemetery centroid (Find a Grave default pins leak through)
  const cem = model.meta.cem;
  const reqGpsReal = req.lat != null && req.lng != null &&
    CS.distM(req.lat, req.lng, cem.lat, cem.lng) >= 5 &&
    CS.distM(req.lat, req.lng, cem.lat, cem.lng) <= 800;
  const memPin = req.mem && req.mem.lat != null ? req.mem : null;
  if (reqGpsReal) {
    req.loc = { lat: req.lat, lng: req.lng, acc: 8, level: 'gps', map: null };
    req.pBest = req.pRos || req.pFag || null;
  } else if (memPin) {
    // the memorial's own pin (already junk-filtered at build time) is the next-best truth
    req.loc = { lat: memPin.lat, lng: memPin.lng, acc: 8, level: 'gps', map: null };
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
  // last resort: Find a Grave's own family links. Spouses (and most parents/
  // children) share the lot — a located family member puts this request on
  // the map at "family lot" precision instead of nowhere at all.
  if (!req.loc && req.mem) {
    famIndexes(model);
    const names = new Set();
    for (const f of req.mem.fam) names.add(CS.normName(f));
    const reqName = CS.normName(req.mem.name);
    const cands = new Map();
    for (const fn of names) for (const m of (model._nameIdx.get(fn) || [])) if (m.mid !== req.mid) cands.set(m.mid, m);
    for (const m of (model._famIdx.get(reqName) || [])) if (m.mid !== req.mid) cands.set(m.mid, m);
    let best = null;
    for (const m of cands.values()) {
      let loc = null;
      if (m.lat != null) loc = { lat: m.lat, lng: m.lng, acc: 8, level: 'gps' };
      else if (m.p) loc = CS.locate(model, m.p);
      if (!loc || (loc.level !== 'gps' && loc.level !== 'lot' && loc.level !== 'adjacent')) continue;
      if (!best || loc.acc < best.loc.acc) best = { m, loc };
    }
    if (best) {
      req.loc = { lat: best.loc.lat, lng: best.loc.lng, acc: Math.max(10, best.loc.acc + 4), level: 'family', map: null, xy: null, via: best.m.name };
      if (!req.pBest && best.m.p) req.pBest = best.m.p;
    }
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
    let dist, rel;
    if (isFinite(lotNum) && isFinite(qLot)) { dist = Math.abs(qLot - lotNum); rel = dist === 0 ? 'same lot' : dist + ' lot' + (dist > 1 ? 's' : '') + ' away'; }
    else if (p.lot && q.lot && String(q.lot) === String(p.lot)) { dist = 0; rel = 'same lot'; }
    else if (!p.lot && !q.lot) { dist = 3; rel = 'same block'; } // lot-less rows are block-mates, not lot-mates
    else continue;
    if (dist > 3) continue;
    // dedupe: matched roster+memorial pairs count once (prefer memorial)
    if (who.kind === 'ros' && who.mem) continue;
    const dk = who.kind === 'mem' ? 'm' + who.mid : 'r' + who.key;
    if (seen.has(dk)) continue;
    seen.add(dk);
    items.push({
      who, lotDist: dist, rel, lot: q.lot, grave: q.grave || '',
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

/* ---------------- family hints ---------------- */
// For requests with no plot info: same-surname burials whose graves ARE locatable.
// Families bought adjacent lots; spouses are usually in the same lot even unmarked.
/* name indexes for true-family lookups, built once per model on demand */
function famIndexes(model) {
  if (model._nameIdx) return model;
  const nameIdx = new Map();  // normalized full name -> [memorials]
  const famIdx = new Map();   // normalized family-member name -> [memorials listing them]
  const add = (map, k, m) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(m); };
  for (const m of model.memorials) {
    add(nameIdx, CS.normName(m.name), m);
    for (const f of m.fam) add(famIdx, CS.normName(f), m);
  }
  model._nameIdx = nameIdx;
  model._famIdx = famIdx;
  return model;
}

CS.familyHints = function (model, req, limit) {
  const lastN = CS.normName(req.ln), lastS = CS.soundex(req.ln);
  if (!lastN) return [];
  const out = [];

  /* TRUE family first: Find a Grave's own spouse/children links — these carry
     across surnames (married daughters) and are the strongest field lead */
  famIndexes(model);
  const reqName = CS.normName(req.name || (req.fn + ' ' + req.ln));
  const famNames = new Set();
  const mem = req.mid != null ? model.memById.get(req.mid) : null;
  if (mem) for (const f of mem.fam) famNames.add(CS.normName(f));
  const trueFam = new Map(); // mid -> memorial
  for (const fn of famNames) {
    for (const m of (model._nameIdx.get(fn) || [])) if (m.mid !== req.mid) trueFam.set(m.mid, m);
  }
  for (const m of (model._famIdx.get(reqName) || [])) if (m.mid !== req.mid) trueFam.set(m.mid, m);
  for (const m of trueFam.values()) {
    let loc = null;
    if (m.lat != null) loc = { lat: m.lat, lng: m.lng, acc: 6, level: 'gps' };
    else if (m.p) loc = CS.locate(model, m.p);
    out.push({
      name: m.name, years: yearsOf(m), mid: m.mid, hasPhoto: m.hasGravePhoto,
      plot: m.plot || '', loc, yearGap: 0, exactLast: true, isFamily: true,
    });
    if (out.length >= (limit || 8)) return out;
  }
  const famMids = new Set(out.map(f => f.mid));
  for (const m of model.memorials) {
    if (m.mid === req.mid || famMids.has(m.mid)) continue;
    const exactLast = m.nl === lastN || (m.nm && m.nm === lastN);
    if (!exactLast && m.sx !== lastS) continue;
    const yearGap = (req.dy && m.dy) ? Math.abs(req.dy - m.dy) : (req.by && m.by) ? Math.abs(req.by - m.by) : 60;
    // quality gates: sound-alike surnames only count with tight year proximity;
    // distant generations are rarely useful leads
    if (!exactLast && yearGap > 5) continue;
    if (yearGap > 40) continue;
    let loc = null;
    if (m.lat != null) loc = { lat: m.lat, lng: m.lng, acc: 6, level: 'gps' };
    else if (m.p) loc = CS.locate(model, m.p);
    // a lead you can neither walk to nor look at teaches nothing in the field
    if (!loc && !m.hasGravePhoto) continue;
    out.push({
      name: m.name, years: yearsOf(m), mid: m.mid, hasPhoto: m.hasGravePhoto,
      plot: m.plot || '', loc, yearGap, exactLast,
    });
  }
  out.sort((a, b) =>
    (b.isFamily ? 1 : 0) - (a.isFamily ? 1 : 0) ||
    (b.exactLast ? 1 : 0) - (a.exactLast ? 1 : 0) ||
    a.yearGap - b.yearGap ||
    ((b.loc ? 1 : 0) - (a.loc ? 1 : 0)));
  return out.slice(0, limit || 8);
};

/* "tried and failed" often means the FAG memorial is filed at the WRONG cemetery.
   Look for the same person in the OTHER nearby cemeteries' memorials + registers. */
CS.crossCemeteryMatches = function (models, req, ownModel) {
  const out = [];
  if (!req.nl || (!req.dy && !req.by)) return out;
  for (const model of models) {
    if (model === ownModel) continue;
    for (const m of model.memorials) {
      if (m.nl !== req.nl) continue;
      if (m.mid === req.mid) continue;
      const firstOk = req.cf && m.cf && (req.cf === m.cf || req.fr === m.fr);
      if (!firstOk) continue;
      const dyOk = req.dy && m.dy && Math.abs(req.dy - m.dy) <= 1;
      const byOk = req.by && m.by && Math.abs(req.by - m.by) <= 1;
      if (!dyOk && !byOk) continue;
      if ((req.dy && m.dy && Math.abs(req.dy - m.dy) > 1) || (req.by && m.by && Math.abs(req.by - m.by) > 1)) continue;
      out.push({ kind: 'mem', item: m, model });
      if (out.length >= 3) return out;
    }
    for (const r of model.roster) {
      if (r.mem) continue;
      if (r.nl !== req.nl) continue;
      const firstOk = req.cf && r.cf && (req.cf === r.cf || req.fr === r.fr);
      if (!firstOk) continue;
      const dyOk = req.dy && r.dy && Math.abs(req.dy - r.dy) <= 1;
      if (!dyOk) continue;
      out.push({ kind: 'ros', item: r, model });
      if (out.length >= 3) return out;
    }
  }
  return out;
};

/* era -> section suggestion: when a plotless request has a death year, say where
   that era's burials cluster in this cemetery */
CS.suggestSection = function (model, dy) {
  if (!dy) return null;
  if (!model._eraSecs) {
    const secs = new Map();
    for (const m of model.memorials) {
      if (!m.dy || !m.p || !m.p.section || m.p.section === '*') continue;
      if (!secs.has(m.p.section)) secs.set(m.p.section, []);
      secs.get(m.p.section).push(m.dy);
    }
    model._eraSecs = secs;
  }
  let best = null, bestN = 0, total = 0;
  for (const [sec, years] of model._eraSecs) {
    if (years.length < 15) continue;
    const n = years.reduce((s, y) => s + (Math.abs(y - dy) <= 6 ? 1 : 0), 0);
    total += n;
    if (n > bestN) { bestN = n; best = sec; }
  }
  if (!best || total < 10 || bestN / total < 0.45) return null;
  return { section: best, share: Math.round(100 * bestN / total) };
};

/* research deep links for the truly stuck cases */
CS.researchLinks = function (person) {
  const first = person.fn || person.first || '';
  const last = person.ln || person.last || '';
  const dy = person.dy || '';
  const q = encodeURIComponent((first + ' ' + last).trim());
  const links = [];
  if (dy) {
    links.push({
      label: 'MI death record',
      url: `https://www.familysearch.org/search/record/results?q.givenName=${encodeURIComponent(first)}&q.surname=${encodeURIComponent(last)}&q.deathLikeDate.from=${dy - 2}&q.deathLikeDate.to=${dy + 2}&q.deathLikePlace=Michigan`,
    });
    if (dy <= 1963) {
      links.push({
        label: 'newspaper obituary',
        url: `https://chroniclingamerica.loc.gov/search/pages/results/?state=Michigan&andtext=%22${q}%22&date1=${dy}&date2=${Math.min(dy + 1, 1963)}&dateFilterType=yearRange&rows=20`,
      });
    }
  }
  if (person.veteran || (person.mem && person.mem.veteran)) {
    links.push({ label: 'VA gravesite locator', url: 'https://gravelocator.cem.va.gov/' });
  }
  links.push({ label: 'web search', url: `https://www.google.com/search?q=%22${q}%22${dy ? '+' + dy : ''}+obituary+Michigan` });
  return links;
};

/* ---------------- search ---------------- */
CS.search = function (model, q, limit) {
  q = CS.normName(q);
  if (!q || q.length < 2) return [];
  const terms = q.split(' ').filter(Boolean);
  const out = [];
  const test = sk => terms.every(t => sk.includes(t));
  for (const m of model.memorials) {
    if (test(m.sk)) { out.push({ kind: 'mem', item: m }); if (out.length >= (limit || 60)) return out; }
  }
  for (const r of model.roster) {
    if (r.mem) continue; // shown via memorial
    if (test(r.sk)) { out.push({ kind: 'ros', item: r }); if (out.length >= (limit || 60)) return out; }
  }
  return out;
};
// search across many cemetery models with a PER-CEMETERY cap so one big cemetery
// can't crowd out all the others; results carry their model
CS.searchAll = function (models, q, opts) {
  const perCem = (opts && opts.perCem) || 6;
  const total = (opts && opts.total) || (typeof opts === 'number' ? opts : 120);
  const out = [];
  let truncated = false;
  for (const model of models) {
    const hits = CS.search(model, q, perCem + 1);
    if (hits.length > perCem) truncated = true;
    for (const hit of hits.slice(0, perCem)) {
      hit.model = model;
      out.push(hit);
    }
    if (out.length >= total) { truncated = true; break; }
  }
  out.truncated = truncated;
  return out;
};

/* ---------------- imports ---------------- */
// Photo-request JSON from the bookmarklet (raw FAG ajax payload or already-array)
CS.parseRequestsJson = function (text, cem) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { error: 'Not valid JSON: ' + e.message }; }
  const arr = Array.isArray(data) ? data : (data.photoRequests || data.requests || null);
  if (!arr || !Array.isArray(arr)) return { error: 'JSON does not contain a photoRequests array.' };
  const requests = arr.map(r => {
    let lat = (r.latLonMethod === 'memorial' && r.latitude) ? +r.latitude : (r.lat != null ? r.lat : null);
    let lng = (r.latLonMethod === 'memorial' && r.longitude) ? +r.longitude : (r.lng != null ? r.lng : null);
    // junk-pin filter: default pins sit exactly on the cemetery centroid
    if (lat != null && cem && cem.lat != null) {
      const d = CS.distM(lat, lng, cem.lat, cem.lng);
      if (!isFinite(d) || d < 5 || d > 800) { lat = null; lng = null; }
    }
    return {
      prId: r.photoRequestId || r.prId || null,
      mid: +(r.memorialId || r.mid) || null,
      cid: +(r.cemeteryId || r.cid) || null,
      fn: r.firstName || r.fn || '', ln: r.lastName || r.ln || '',
      name: r.memorialName || r.name || ((r.firstName || '') + ' ' + (r.lastName || '')).trim(),
      by: r.birthYear || r.by || null, dy: r.deathYear || r.dy || null,
      bd: r.birthDate || r.bd || '', dd: r.deathDate || r.dd || '',
      plot: r.longPlot || r.plot || '', notes: r.notes || '',
      req: r.reqPublicName || r.req || '', created: r.dateCreated || r.created || '',
      claimed: r.dateClaimed || r.claimed || '',
      problem: String(r.problemDetails || r.problems || r.problem || '').replace(/\s+/g, ' ').trim().substring(0, 140),
      lat, lng,
    };
  }).filter(r => r.mid);
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
CS.parseRosterText = function (text, profile) {
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
      const p = CS.parsePlot(s, profile);
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
CS.parseRosterSheet = function (rows, profile) {
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
      const canon = profile === 'oakgrove' ? (BSA_SECTION[raw] || BSA_SECTION[raw.replace(/^0/, '')]) : null;
      if (canon) { section = canon[0]; sub = canon[1]; }
      else if (/^\d+$/.test(raw)) section = 'Section ' + raw.replace(/^0+(?=\d)/, '');
      else { const p = CS.parsePlot(raw + ' Lot 0', profile); section = p ? p.section : raw; }
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
