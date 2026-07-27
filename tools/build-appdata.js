// Generates oakgrove-data.js for the app: photo requests, memorial index,
// BS&A roster (if pulled), plat geometry, section centroids.
const fs = require('fs');

const geo = JSON.parse(fs.readFileSync('plat-geometry.json', 'utf8'));
const mem = JSON.parse(fs.readFileSync('memorials.json', 'utf8'));
const pr = JSON.parse(fs.readFileSync('photo-requests.json', 'utf8'));

/* ---- shared plot parser (kept in sync with the app's copy) ---- */
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
function parsePlot(plotStr) {
  if (!plotStr) return null;
  let s = String(plotStr).replace(/[().,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /no location|unknown|pottersfield/i.test(s)) return null;
  let section = null;
  for (const [re, name] of SECTION_PATTERNS) if (re.test(s)) { section = name; break; }
  if (!section) return null;
  const sub = (s.match(/\bSub\.?\s*:?\s*(\d+)\b/i) || [])[1] || '';
  const block = ((s.match(/\b(?:Blk|Block|Row)\s+([A-Z]{1,2}|\d{1,3})\b/i) || [])[1] || '').toUpperCase();
  const lot = (s.match(/\bLot:?\s*#?\s*([A-Z0-9]+(?:[-/][A-Z0-9]+)?)\b/i) || [])[1] || '';
  const grave = (s.match(/\b(?:Grave|Space|Plot)\s+([0-9]+(?:[-/][0-9]+)?)\b/i) || [])[1] || '';
  const lotNum = parseInt(lot);
  return { section, sub, block, lot: isFinite(lotNum) ? String(lotNum) : lot, grave };
}

/* ---- BS&A section code -> canonical section (from city plat maps) ---- */
const BSA_SECTION = {
  '01': ['Old Part', '1'], '02': ['Old Part', '2'], '03': ['Old Part', '3'],
  '04': ['Old Part', '4'], '05': ['Old Part', '5'],
  '1': ['Old Part', '1'], '2': ['Old Part', '2'], '3': ['Old Part', '3'],
  '4': ['Old Part', '4'], '5': ['Old Part', '5'],
  '06': ['Vault Hill', ''], '6': ['Vault Hill', ''],
  '07': ['Oak Hill', ''], '7': ['Oak Hill', ''],
  '09': ['Mausoleum', ''], '9': ['Mausoleum', ''],
  '10': ['Round Hill', ''],
  '11': ['Square Hill', ''],
  '12': ['Hofstetter Hill', ''],
  '13': ['Cutler Hill', ''],
  '14': ['Single Grave', ''],
  '15': ['Morris Hill', ''],
  '16': ['Veteran Hill', ''],
  '17': ['North Hill', ''],
  // catch-all bucket for old burials with unknown plots — not a location
  '25': ['', ''],
};

/* ---- requests ---- */
const requests = pr.photoRequests.map(r => {
  const hasGps = r.latLonMethod === 'memorial';
  return {
    prId: r.photoRequestId,
    mid: r.memorialId,
    fn: r.firstName || '',
    ln: r.lastName || '',
    name: r.memorialName || ((r.firstName || '') + ' ' + (r.lastName || '')).trim(),
    by: r.birthYear || null,
    dy: r.deathYear || null,
    bd: r.birthDate || '',
    dd: r.deathDate || '',
    plot: r.longPlot || '',
    notes: r.notes || '',
    req: r.reqPublicName || '',
    created: r.dateCreated || '',
    lat: hasGps ? +r.latitude : null,
    lng: hasGps ? +r.longitude : null,
  };
});

/* ---- memorial index (compact arrays) ---- */
// [mid, name, maiden, by, dy, plotRaw, lat, lng, flags]
// flags: 1 = grave photo exists, 2 = has open photo request, 4 = veteran, 8 = person photo exists
const CEM = geo.cem;
const M_PER_DEG_LAT = Math.PI / 180 * 6371000;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(CEM.lat * Math.PI / 180);
const memorials = mem.records.map(r => {
  let lat = null, lng = null;
  if (r.latitude != null && r.longitude != null) {
    const la = +r.latitude, ln2 = +r.longitude;
    const dc = Math.hypot((ln2 - CEM.lng) * M_PER_DEG_LNG, (la - CEM.lat) * M_PER_DEG_LAT);
    if (isFinite(dc) && dc >= 5 && dc <= 500) { lat = +la.toFixed(6); lng = +ln2.toFixed(6); }
  }
  let flags = 0;
  if (r.intermentHasPhoto) flags |= 1;
  if (r.photoRequest) flags |= 2;
  if (r.isVeteran) flags |= 4;
  if (r.personHasPhoto) flags |= 8;
  return [
    r.memorialId,
    r.fullName || '',
    r.maidenName || '',
    r.birthYear || 0,
    r.deathYear || 0,
    (r.plot || '').replace(/\s+/g, ' ').trim(),
    lat, lng, flags,
  ];
});

/* ---- BS&A roster (optional at this stage) ---- */
let roster = [];
if (fs.existsSync('bsa-records.jsonl')) {
  const lines = fs.readFileSync('bsa-records.jsonl', 'utf8').split('\n').filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.miss || !r.Name || seen.has(r.key)) continue;
    seen.add(r.key);
    const canon = BSA_SECTION[(r.Section || '').trim()] || null;
    // [key, name, sex, birthDate, deathDate, burialDate, section, sub, block, lot, grave, status, flags, note]
    let flags = 0;
    if (/^y/i.test(r.Veteran || '')) flags |= 4;
    const note = [r['User 3'], r.Notes, r['Buriel at head'] ? 'head: ' + r['Buriel at head'] : '', r['Buriel at Foot'] ? 'foot: ' + r['Buriel at Foot'] : '']
      .filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim().substring(0, 160);
    roster.push([
      r.key,
      (r.Name || '').trim(),
      (r.Sex || '').trim(),
      (r['Birth Date'] || '').trim(),
      (r['Death Date'] || '').trim(),
      (r['Burial Date'] || '').trim(),
      canon ? canon[0] : ((r.Section || '').trim()),
      canon ? canon[1] : '',
      (r.Block || '').trim().toUpperCase(),
      (r.Lot || '').trim().replace(/^0+(?=\d)/, ''),
      (r.Plot || '').trim(),
      (r.Status || '').trim(),
      flags,
      note,
      (r['Former Name'] || '').trim(),
    ]);
  }
  console.log('roster records:', roster.length);
}

/* ---- geometry: compact entries ---- */
const maps = geo.maps.map(m => ({
  file: m.file, section: m.section, sub: m.sub, style: m.style,
  page: m.page, transform: m.transform, quality: m.quality,
  looMedian: m.loo ? m.loo.median : null,
  entries: m.entries.map(e => [e.b, String(parseInt(e.l) || e.l), Math.round(e.x * 10) / 10, Math.round(e.y * 10) / 10]),
  blocks: m.blocks, roads: m.roads,
}));

const out = {
  meta: {
    cemetery: 'Oak Grove Cemetery, St. Louis, Michigan',
    fagCemeteryId: 1252,
    asOf: '2026-07-26',
    cem: CEM,
    declination: -6.6, // magnetic -> true: true = magnetic - 6.6 (NOAA WMM 2026)
    counts: { requests: requests.length, memorials: memorials.length, roster: roster.length },
    mapPdfBase: 'https://www.stlouismi.com/download/',
    mapPdfs: {
      overview: '6331/cemetary-map-overview.pdf',
    },
    clerk: 'City Clerk Jamie Long, (989) 681-2137 ext. 1050, jlong@stlouismi.com',
  },
  sections: geo.sections,
  maps,
  requests,
  memorials,
  roster,
};

const js = '// Oak Grove Cemetery preloaded dataset — generated ' + out.meta.asOf + '\n' +
  '// Sources: Find a Grave cemetery 1252 (photo requests + memorial index),\n' +
  '// City of St. Louis MI plat maps (stlouismi.com), BS&A Online public burial register.\n' +
  'window.OAKGROVE = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync('oakgrove-data.js', js);
console.log('wrote oakgrove-data.js:', (js.length / 1024).toFixed(0) + ' KB',
  '| requests:', requests.length, '| memorials:', memorials.length, '| roster:', roster.length,
  '| maps:', maps.length);
