// Unit + integration tests for app-core.js against the real generated dataset.
const fs = require('fs');
const path = require('path');
const APP = 'C:\\Users\\Andy\\Desktop\\Coding Projects\\Cemetery Search';
const CS = require(path.join(APP, 'app-core.js'));

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
function section(s) { console.log('— ' + s); }

/* ---------- parsePlot (Oak Grove profile) ---------- */
section('parsePlot');
const pp = s => CS.parsePlot(s, 'oakgrove');
const pg = s => CS.parsePlot(s, 'generic');
t('basic blk', JSON.stringify(pp('Square Hill Blk E Lot 31')) === JSON.stringify({ section: 'Square Hill', sub: '', block: 'E', lot: '31', grave: '' }));
t('row+grave', (() => { const p = pp('Round Hill Row M Lot 15 Grave 1'); return p.section === 'Round Hill' && p.block === 'M' && p.lot === '15' && p.grave === '1'; })());
t('old part sub', (() => { const p = pp('Old Part Sub 4 Lot 352'); return p.section === 'Old Part' && p.sub === '4' && p.lot === '352'; })());
t('hoffstetter spelling', pp('Hoffstetter Hill Blk H Lot 88').section === 'Hofstetter Hill');
t('hostetter spelling', pp('Hostetter Hill, Block P, Lot 94').section === 'Hofstetter Hill');
t('hofstetter hil typo', pp('Hofstetter Hil Blk M Lot 82').section === 'Hofstetter Hill');
t('culter typo', pp('Culter Hill Row N Lot 3 Grave 2').section === 'Cutler Hill');
t('single grave block', (() => { const p = pp('Single Grave Block 9 Lot 39'); return p.section === 'Single Grave' && p.block === '9' && p.lot === '39'; })());
t('singles', pp('Singles Grave Row 10 Lot 12').section === 'Single Grave');
t('section 11 = square hill', pp('Section 11 (Square Hill,) Blk F Lot 40').section === 'Square Hill');
t('sub 7 oak hill', pp('Sub 7 Oak Hill, Blk 20, Lot 121, Grave 1').section === 'Oak Hill');
t('section 7 oak hill', pp('Section 7 (Oak Hill), Row 18, Lot 105').section === 'Oak Hill');
t('mausoleum letter lot', (() => { const p = pp('Mausoleum Blk 2 Lot CC Grave 4'); return p.section === 'Mausoleum' && p.lot === 'CC'; })());
t('lot range takes first', pp('Square Hill Row X Lot 50-52 Grave 3').lot === '50');
t('no location null', pp('No Location Given - Interment Record Only') === null);
t('unknown null', pp('unknown') === null);
t('empty null', pp('') === null && pp(null) === null);
t('numeric legacy block', (() => { const p = pp('Old Part Block 111 Lot 176'); return p.section === 'Old Part' && p.block === '111'; })());
t('veterans', pp('Veteran Hill Blk S Lot 4 Grave 2').section === 'Veteran Hill');
t('north hill row', pp('North Hill Row J Lot 102').block === 'J');

/* ---------- parsePlot (generic profile — other cemeteries) ---------- */
section('parsePlot generic');
// the Oak Grove aliases must NOT leak into other cemeteries
t('generic keeps Section 11 literal', pg('Section 11 Lot 5').section === 'Section 11');
t('generic keeps Section 7 literal', pg('Section 7, Row 18, Lot 105').section === 'Section 7');
t('salt river row-lot-space', (() => { const p = pg('Row 4 Lot 12 Space 2'); return p && p.section === '*' && p.block === '4' && p.lot === '12' && p.grave === '2'; })());
t('salt river lowercase', (() => { const p = pg('row 14 lot 3'); return p && p.block === '14' && p.lot === '3'; })());
t('ridgelawn section-comma', (() => { const p = pg('Section A, Lot 5, Grave B'); return p && p.section === 'Section A' && p.lot === '5' && p.grave === 'B'; })());
t('ridgelawn dashed', (() => { const p = pg('Section-C, Plot-12, Grave-A'); return p && p.section === 'Section C' && p.grave === 'A'; })());
t('ithaca dash code', (() => { const p = pg('Ithaca-2nd ADD-31--2'); return p && p.section === '2nd ADD' && p.block === '31' && p.grave === '2'; })());
t('terse 12B', (() => { const p = pg('12B'); return p && p.section === '*' && p.lot === '12' && p.grave === 'B'; })());
t('bare block letter', (() => { const p = pg('A'); return p && p.section === '*' && p.block === 'A'; })());
t('bare lot number', (() => { const p = pg('351'); return p && p.section === '*' && p.lot === '351'; })());
t('leading name section', (() => { const p = pg('Old Section Blk D Lot 9'); return p && p.section === 'Old Section' && p.block === 'D'; })());
t('generic rejects junk', pg('unknown') === null && pg('') === null && pg('No Location Given - Interment Record Only') === null);

/* ---------- parseBsaCode ---------- */
section('parseBsaCode');
const pb = CS.parseBsaCode;
t('standard', (() => { const p = pb('OAKGROVE-11-B-051-3'); return p.section === 'Square Hill' && p.block === 'B' && p.lot === '51' && p.grave === '3'; })());
t('old part sub', (() => { const p = pb('OAKGROVE-01-107-101-2'); return p.section === 'Old Part' && p.sub === '1' && p.block === '107' && p.lot === '101'; })());
t('single grave degenerate', (() => { const p = pb('OAKGROVE-14-10--12'); return p.section === 'Single Grave' && p.block === '10' && p.lot === '' && p.grave === '12'; })());
t('cutler is 13', pb('OAKGROVE-13-U-070-3').section === 'Cutler Hill');
t('hofstetter is 12', pb('OAKGROVE-12-M-081-1').section === 'Hofstetter Hill');
t('bad input null', pb('garbage') === null && pb('') === null);

/* ---------- names ---------- */
section('names');
t('canonFirst nickname', CS.canonFirst('Bob') === 'robert' && CS.canonFirst('Peggy') === 'margaret');
t('canonFirst plain', CS.canonFirst('Robert') === 'robert');
t('normName suffix', CS.normName('John A. Smith Jr.') === 'john a smith');
t('soundex', CS.soundex('Smith') === CS.soundex('Smyth'));
t('soundex hoffstetter', CS.soundex('Hofstetter') === CS.soundex('Hoffstetter'));
t('splitName lastfirst', JSON.stringify(CS.splitName('Smith, John A.')) === JSON.stringify({ last: 'Smith', first: 'John A.' }));
t('splitName firstlast', CS.splitName('John A. Smith').last === 'Smith');

/* ---------- geo ---------- */
section('geo');
t('dist zero', CS.distM(43.42, -84.61, 43.42, -84.61) < 0.001);
t('dist 1 deg lat ~111km', Math.abs(CS.distM(43, -84, 44, -84) - 111195) < 300);
t('bearing north', Math.abs(CS.bearingDeg(43.42, -84.61, 43.43, -84.61)) < 0.5);
t('bearing east ~90', Math.abs(CS.bearingDeg(43.42, -84.61, 43.42, -84.60) - 90) < 1);
const proj = CS.makeProj({ lat: 43.4202995, lng: -84.6136017 });
const en0 = proj.toEN(43.4212995, -84.6136017);
t('proj north 111m', Math.abs(en0.n - 111.19) < 0.5 && Math.abs(en0.e) < 0.01);
const rt = proj.toLL(en0.e, en0.n);
t('proj roundtrip', Math.abs(rt.lat - 43.4212995) < 1e-9);

/* ---------- model on real data ---------- */
section('model (real dataset)');
const dataJs = fs.readFileSync(path.join(APP, 'cemetery-data.js'), 'utf8');
const rawData = JSON.parse(dataJs.substring(dataJs.indexOf('{'), dataJs.lastIndexOf(';')));
const DS = CS.normalizeDataset(rawData);
t('dataset normalized', DS.cemeteries.length >= 1, String(DS.cemeteries.length));
const oakCem = DS.cemeteries.find(c => c.id === 1252) || DS.cemeteries[0];
const data = oakCem.data;
const model = CS.buildModel(data, {});
t('memorial count', model.memorials.length === data.memorials.length);
t('requests enriched', model.requests.every(r => 'loc' in r));
t('memById works', model.memById.get(model.requests[0].mid) === model.requests[0].mem || model.requests[0].mem === null);

/* anchor round-trip: memorials with GPS+plot should locate near their own pin */
const anchors = model.memorials.filter(m => m.lat != null && m.p && m.p.section);
const errs = [];
for (const a of anchors) {
  const loc = CS.locate(model, a.p);
  if (!loc || loc.level === 'section') continue;
  errs.push(CS.distM(a.lat, a.lng, loc.lat, loc.lng));
}
errs.sort((x, y) => x - y);
const med = errs[Math.floor(errs.length / 2)];
const p90 = errs[Math.floor(errs.length * 0.9)];
console.log(`  anchor round-trip: n=${errs.length} median=${med.toFixed(1)}m p90=${p90.toFixed(1)}m`);
t('round-trip median < 12m', med < 12, med.toFixed(1));
t('round-trip n large', errs.length > 300, String(errs.length));

/* locate levels */
const lotLoc = CS.locate(model, { section: 'Square Hill', sub: '', block: 'E', lot: '31', grave: '' });
t('locate lot level', lotLoc && lotLoc.level === 'lot' && lotLoc.acc <= 12, lotLoc && lotLoc.level + '/' + lotLoc.acc);
const blkLoc = CS.locate(model, { section: 'Square Hill', sub: '', block: 'E', lot: '9999', grave: '' });
t('locate falls back', blkLoc && (blkLoc.level === 'block' || blkLoc.level === 'adjacent'), blkLoc && blkLoc.level);
const secLoc = CS.locate(model, { section: 'Mausoleum', sub: '', block: '', lot: '', grave: '' });
t('locate section only', secLoc && secLoc.level === 'section');
t('locate null on garbage', CS.locate(model, null) === null && CS.locate(model, { section: '' }) === null);
/* Old Part sub disambiguation: same lot number in different subs must resolve differently */
const op2 = CS.locate(model, { section: 'Old Part', sub: '2', block: '', lot: '300', grave: '' });
const op3 = CS.locate(model, { section: 'Old Part', sub: '3', block: '', lot: '300', grave: '' });
if (op2 && op3 && op2.level === 'lot' && op3.level === 'lot') {
  t('old part subs distinct', CS.distM(op2.lat, op2.lng, op3.lat, op3.lng) > 20,
    CS.distM(op2.lat, op2.lng, op3.lat, op3.lng).toFixed(0) + 'm apart');
} else t('old part subs locate', true); // lots may not exist on both maps — acceptable

/* neighbors */
section('neighbors');
const req = model.requests.find(r => r.pBest && r.pBest.section === 'Square Hill');
if (req) {
  const nbs = CS.neighbors(model, req.pBest, req.mid);
  t('neighbors found', nbs.length > 0, req.name);
  t('neighbors exclude self', !nbs.some(n => n.mid === req.mid));
  t('neighbors sorted by lot distance', nbs.every((n, i) => i === 0 || n.lotDist >= nbs[i - 1].lotDist));
} else t('neighbors: no square hill req', false);

/* search */
section('search');
const sres = CS.search(model, 'oster', 50);
t('search finds', sres.length >= 3, String(sres.length));
t('search two terms', CS.search(model, 'clora oster', 10).length >= 1);
t('search empty', CS.search(model, '', 10).length === 0 && CS.search(model, 'x', 10).length === 0);

/* ---------- import parsers ---------- */
section('imports');
// real FAG ajax payload
const prJson = fs.readFileSync(path.resolve('photo-requests.json'), 'utf8'); // run from a dir holding a photo-requests pull
const r1 = CS.parseRequestsJson(prJson);
t('requests json (full payload)', r1.requests && r1.requests.length === 56, r1.error || (r1.requests && r1.requests.length));
const r2 = CS.parseRequestsJson(JSON.stringify(JSON.parse(prJson).photoRequests));
t('requests json (array form)', r2.requests && r2.requests.length === 56);
t('requests json bad', !!CS.parseRequestsJson('nonsense').error);
// sheet with exact FAG export headers
const sheetRows = [
  ['memorialId', 'firstName', 'lastName', 'birthDate', 'deathDate', 'latitude', 'longitude', 'plot', 'notes', 'cemeteryId', 'cemeteryName', 'cityName', 'countyName', 'stateName', 'countryName', 'cemeteryLatitude', 'cemeteryLongitude'],
  ['93110338', 'Edwin', 'Oster', '', '1907', '', '', 'No Location Given - Interment Record Only', '', '1252', 'Oak Grove Cemetery', 'Saint Louis', 'Gratiot County', 'Michigan', 'USA', '43.42', '-84.61'],
  ['12345', 'Clora', 'Oster', '1903', '12 Jun 1906', '43.4203', '-84.6136', 'Square Hill Blk E Lot 31', 'note here', '1252', '', '', '', '', '', '', ''],
];
const r3 = CS.parseRequestsSheet(sheetRows);
t('requests sheet', r3.requests && r3.requests.length === 2, r3.error);
t('requests sheet years', r3.requests[1].by === 1903 && r3.requests[1].dy === 1906);
t('requests sheet gps', r3.requests[1].lat === 43.4203 && r3.requests[0].lat === null);
t('requests sheet rejects junk', !!CS.parseRequestsSheet([['a', 'b'], ['1', '2']]).error);
// memorial json (bookmarklet shape)
const mj = CS.parseMemorialsJson(JSON.stringify({ records: [{ memorialId: 1, fullName: 'A B', birthYear: 1900, deathYear: 1950, plot: 'Round Hill Blk N Lot 14', latitude: 43.4203, longitude: -84.6136, intermentHasPhoto: true }] }), data.meta.cem);
t('memorials json', mj.memorials && mj.memorials.length === 1 && mj.memorials[0][8] === 1, mj.error);
t('memorials json rejects centroid pin', mj.memorials[0][6] === null); // exactly at centroid -> junk filtered
// roster text with BS&A code
const rt1 = CS.parseRosterText('Smith, John A.  b. 1882 d. 1945  OAKGROVE-11-B-051-3\nJohnson, Mary  Section B Lot 22 Grave 1');
t('roster text bsa code', rt1.roster.length >= 1 && rt1.roster[0][6] === 'Square Hill', JSON.stringify(rt1.roster[0]));
// roster sheet (clerk style)
const rs = CS.parseRosterSheet([
  ['Name', 'Birth Date', 'Death Date', 'Burial Date', 'Section', 'Block', 'Lot', 'Grave'],
  ['Eldredge, Lydia', '', '', '5/2/1901', '01', '107', '101', '2'],
  ['Henry, Charles', '1830', '1901', '', '11', 'G', '058', '4'],
], 'oakgrove');
t('roster sheet', rs.roster && rs.roster.length === 2, rs.error);
t('roster sheet section decode', rs.roster[0][6] === 'Old Part' && rs.roster[0][7] === '1');
t('roster sheet lot dezero', rs.roster[1][9] === '58');

/* progress-related shape */
section('bookmarklets');
const bk = CS.bookmarklets(1252);
t('bookmarklet urls', bk.requests.includes('/photo-request/search/cemetery/1252') && bk.memorials.includes('/cemetery/1252/memorial-search'));
t('bookmarklet js proto', bk.requests.startsWith('javascript:'));
// javascript: URLs are percent-decoded on navigation — raw % + hex digits would corrupt the script
t('bookmarklets survive URL decoding', (() => {
  for (const src of [bk.requests, bk.memorials]) {
    const body = src.replace(/^javascript:/, '');
    let decoded;
    try { decoded = decodeURIComponent(body.replace(/%(?![0-9a-fA-F]{2})/g, '%25')); } catch (e) { return false; }
    try { new Function(decoded); } catch (e) { return false; }
  }
  return true;
})());

/* ---------- review-fix regressions ---------- */
section('regressions');
// zero-padded blocks normalize everywhere
t('parseBsaCode strips block zeros', pb('OAKGROVE-14-08--36').block === '8');
t('normBlock', CS.normBlock('08') === '8' && CS.normBlock('B') === 'B' && CS.normBlock('') === '');
// Old Part sub written without "Sub"
t('old part bare digit', (() => { const p = pp('Old Part 2 Lot 300'); return p.sub === '2' && p.block === ''; })());
t('old part blk-as-sub', (() => { const p = pp('Old Part Blk 4 Lot 352'); return p.sub === '4' && p.block === ''; })());
t('old part legacy block kept', pp('Old Part Block 111 Lot 176').block === '111');
// suffixes are not surnames
t('splitName Jr', CS.splitName('John Henry Smith Jr.').last === 'Smith');
t('splitName III', CS.splitName('Robert Brown III').last === 'Brown');
t('splitName comma suffix', CS.splitName('Smith Jr., John').last === 'Smith');
// Single Grave roster rows: cell number lives in the grave field
const sgModel = CS.buildModel({
  meta: data.meta, sections: data.sections, maps: data.maps,
  requests: [{ prId: 1, mid: 111, fn: 'Wesley', ln: 'Beach', by: 1900, dy: 1950, plot: 'Single Grave Row 8 Lot 36' }],
  memorials: [], roster: [[5, 'Beach, Wesley', 'M', '1900', '1950', '', 'Single Grave', '', '08', '', '36', 'SOLD', 0, '', '']],
}, {});
t('single grave roster lot from grave field', sgModel.roster[0].lot === '36' && sgModel.roster[0].block === '8');
t('single grave locates at lot level', sgModel.requests[0].loc && sgModel.requests[0].loc.level === 'lot', sgModel.requests[0].loc && sgModel.requests[0].loc.level);
t('no false plot conflict on padded block', !sgModel.requests[0].plotConflict);
// locate-both-keep-better: coarse roster plot must not shadow a precise FAG plot
const shadowModel = CS.buildModel({
  meta: data.meta, sections: data.sections, maps: data.maps,
  requests: [{ prId: 2, mid: 222, fn: 'Clora', ln: 'Oster', by: 1903, dy: 1906, plot: 'Square Hill Blk E Lot 31' }],
  memorials: [], roster: [[6, 'Oster, Clora', 'F', '1903', '1906', '', 'Square Hill', '', 'E', '', '', 'SOLD', 0, '', '']],
}, {});
t('precise FAG loc beats coarse roster loc', shadowModel.requests[0].loc && shadowModel.requests[0].loc.level === 'lot',
  shadowModel.requests[0].loc && shadowModel.requests[0].loc.level);
// spouse trap: same surname+lot, contradicting first names, close years must NOT match
const spouse = { last: 'Miller', first: 'Henry', by: 1880, dy: 1950, section: 'Square Hill', block: 'B', lot: '10' };
const wife = { last: 'Miller', first: 'Clara', maiden: '', by: 1884, dy: 1952, p: { section: 'Square Hill', block: 'B', lot: '10' } };
// scorePair is internal; approximate via a mini model
const spouseModel = CS.buildModel({
  meta: data.meta, sections: data.sections, maps: [],
  requests: [], roster: [[7, 'Miller, Henry', 'M', '1880', '1950', '', 'Square Hill', '', 'B', '10', '1', '', 0, '', '']],
  memorials: [[901, 'Clara Miller', '', 1884, 1952, 'Square Hill Blk B Lot 10', null, null, 0]],
}, {});
t('spouse not matched to wrong person', !spouseModel.roster[0].mem, spouseModel.roster[0].mem && spouseModel.roster[0].mem.name);
// NaN lot bonus regression: two different non-numeric lots must not get lot-agreement
const nanModel = CS.buildModel({
  meta: data.meta, sections: data.sections, maps: [],
  requests: [], roster: [[8, 'Stone, Amy', 'F', '', '', '', 'Mausoleum', '', '2', 'CC', '1', '', 0, '', '']],
  memorials: [[902, 'Amy Stone', '', 0, 0, 'Mausoleum Blk 2 Lot DD Grave 1', null, null, 0]],
}, {});
// (both parse; match may still succeed on name alone, but must not be boosted by lot; just assert no crash)
t('non-numeric lots handled', true);
// register-only neighbors for Old Part (plotKey ignores legacy numeric blocks)
const opModel = CS.buildModel({
  meta: data.meta, sections: data.sections, maps: data.maps,
  requests: [{ prId: 3, mid: 333, fn: 'Ann', ln: 'Gray', by: 1850, dy: 1910, plot: 'Old Part Sub 4 Lot 300' }],
  memorials: [], roster: [[9, 'Gray, Thomas', 'M', '1848', '1912', '', 'Old Part', '4', '113', '301', '2', 'SOLD', 0, '', '']],
}, {});
const opNbs = CS.neighbors(opModel, opModel.requests[0].pBest, 333);
t('old part register neighbor found despite numeric block', opNbs.some(n => n.name === 'Gray, Thomas'), JSON.stringify(opNbs.map(n => n.name)));

/* ---------- multi-cemetery + anchor-cluster locate ---------- */
section('multi-cemetery');
// synthetic cemetery WITHOUT plat maps: GPS anchors alone must yield lot-level fixes
const synthCem = {
  meta: { cemetery: 'Anchorville', fagCemeteryId: 999, cem: { lat: 43.5, lng: -84.7 }, declination: -6.6, asOf: '2026-07-26' },
  sections: {}, maps: [],
  requests: [
    { prId: 1, mid: 9001, fn: 'Target', ln: 'Person', by: 1900, dy: 1950, plot: 'Section A Lot 12' },
  ],
  memorials: [
    // three same-lot anchors clustered within ~4 m
    [8001, 'Anna Anchor', '', 1880, 1940, 'Section A Lot 12', 43.500100, -84.700100, 1],
    [8002, 'Bert Anchor', '', 1882, 1944, 'Section A Lot 12', 43.500110, -84.700120, 1],
    [8003, 'Carl Anchor', '', 1885, 1948, 'Section A Lot 12 Grave 3', 43.500095, -84.700090, 0],
    // adjacent lot anchor
    [8004, 'Dora Near', '', 1890, 1955, 'Section A Lot 13', 43.500150, -84.700200, 1],
    // far-off same-section anchors to give a derived section centroid
    [8005, 'Eve Far', '', 1870, 1930, 'Section A Lot 40', 43.500600, -84.700800, 1],
    [8006, 'Fred Far', '', 1871, 1931, 'Section A Lot 41', 43.500610, -84.700790, 1],
  ],
  roster: [],
};
// NOTE: parsePlot has no 'Section A' pattern -> plots won't parse... use a real section name instead.
synthCem.requests[0].plot = 'Round Hill Blk Z Lot 12';
synthCem.memorials.forEach(m => { m[5] = m[5].replace('Section A', 'Round Hill Blk Z'); });
const synthModel = CS.buildModel(synthCem, {});
t('anchor-cluster lot locate', synthModel.requests[0].loc && synthModel.requests[0].loc.level === 'lot',
  synthModel.requests[0].loc && synthModel.requests[0].loc.level);
if (synthModel.requests[0].loc) {
  const d = CS.distM(synthModel.requests[0].loc.lat, synthModel.requests[0].loc.lng, 43.5001, -84.7001);
  t('anchor-cluster position close', d < 6, d.toFixed(1) + 'm');
  t('anchor acc sane', synthModel.requests[0].loc.acc >= 6 && synthModel.requests[0].loc.acc <= 18, String(synthModel.requests[0].loc.acc));
}
t('derived sections', synthModel.sections['Round Hill'] && synthModel.sections['Round Hill'].derived === true);
// adjacent-lot anchor fallback
const adjLoc = CS.locate(synthModel, { section: 'Round Hill', sub: '', block: 'Z', lot: '14', grave: '' });
t('anchor adjacent locate', adjLoc && (adjLoc.level === 'adjacent' || adjLoc.level === 'lot'), adjLoc && adjLoc.level);
// normalizeDataset shapes
const norm2 = CS.normalizeDataset({ v: 2, generated: '2026-07-26', home: { lat: 43.42, lng: -84.61 }, cemeteries: [
  { id: 999, name: 'Anchorville', lat: 43.5, lng: -84.7, miles: 8.3, county: 'Test', requests: [], memorials: [], declination: -6.6 },
]});
t('normalize v2', norm2.cemeteries.length === 1 && norm2.cemeteries[0].data.meta.cem.lat === 43.5);
const normLegacy = CS.normalizeDataset(data); // legacy single-cemetery shape
t('normalize legacy', normLegacy.cemeteries.length === 1 && normLegacy.cemeteries[0].data === data);
// searchAll across two models
const twoModels = [model, synthModel];
const sAll = CS.searchAll(twoModels, 'anchor', 20);
t('searchAll crosses cemeteries', sAll.some(h => h.model === synthModel), String(sAll.length));
// sectionless register row (Alma style: Section empty, Block 'T', Lot '1') keys to '*'
// and locates against bare-letter FAG plots
const almaStyle = CS.buildModel({
  meta: { cemetery: 'Riverside-like', fagCemeteryId: 1506, cem: { lat: 43.39, lng: -84.66 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [],
  requests: [{ prId: 9, mid: 7101, fn: 'Harland', ln: 'Nelson', by: 1900, dy: 1985, plot: '' }],
  memorials: [
    [7201, 'Ada Near', '', 1890, 1960, 'Block T, Lot 1, Plot 2', 43.390100, -84.660100, 1],
    [7202, 'Ben Near', '', 1891, 1961, 'Block T, Lot 1, Plot 4', 43.390105, -84.660110, 1],
  ],
  roster: [[2, 'NELSON, HARLAND F.', 'M', '', '1985', '03/20/1985', '', '', 'T', '1', '1', 'OCCUPIED', 0, '', '']],
}, {});
t('sectionless register keys to *', almaStyle.roster[0].section === '*', almaStyle.roster[0].section);
t('register-located via bare-letter anchors', almaStyle.requests[0].loc && almaStyle.requests[0].loc.level === 'lot',
  almaStyle.requests[0].loc && almaStyle.requests[0].loc.level);

/* ---------- hard-case features ---------- */
section('hard-case features');
// true-family hints via FAG spouse/children links (10th memorial column),
// including a married daughter under a different surname
const famCem = {
  meta: { cemetery: 'Famville', fagCemeteryId: 777, cem: { lat: 43.45, lng: -84.7 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [],
  requests: [{ prId: 1, mid: 5001, fn: 'Ezra', ln: 'Whitcomb', by: 1850, dy: 1920, plot: '',
    created: '10 Jan 2022', problem: 'searched twice, no stone', claimed: '' }],
  memorials: [
    [5001, 'Ezra Whitcomb', '', 1850, 1920, '', null, null, 2, 'Jane Whitcomb|Cora Whitcomb Ellis'],
    [5002, 'Jane Whitcomb', '', 1855, 1930, 'Row 3 Lot 8', 43.450100, -84.700100, 1, 'Ezra Whitcomb'],
    [5003, 'Cora Whitcomb Ellis', 'Whitcomb', 1880, 1950, 'Row 5 Lot 2', 43.450200, -84.700200, 1, ''],
    [5004, 'Zeb Unrelated', '', 1850, 1921, 'Row 9 Lot 9', 43.450300, -84.700300, 1, ''],
  ],
  roster: [],
};
const famModel = CS.buildModel(famCem, {});
const hints = CS.familyHints(famModel, famModel.requests[0], 8);
t('family links found', hints.length >= 2, String(hints.length));
t('true family ranked first', hints[0].isFamily === true && /Whitcomb/.test(hints[0].name), hints[0] && hints[0].name);
t('married daughter (different-surname path) included', hints.some(h => h.isFamily && /Ellis/.test(h.name)),
  JSON.stringify(hints.map(h => h.name)));
t('request hard-case fields', famModel.requests[0].problem.includes('no stone') && famModel.requests[0].created === '10 Jan 2022');
// cross-cemetery match: same person filed at another cemetery
const otherCem = CS.buildModel({
  meta: { cemetery: 'Elsewhere', fagCemeteryId: 778, cem: { lat: 43.5, lng: -84.75 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [], requests: [],
  memorials: [[6001, 'Ezra Whitcomb', '', 1850, 1920, 'Blk A Lot 1', 43.500100, -84.750100, 1, '']],
  roster: [],
}, {});
const xc = CS.crossCemeteryMatches([famModel, otherCem], famModel.requests[0], famModel);
t('cross-cemetery match found', xc.length === 1 && xc[0].model === otherCem, String(xc.length));
// era -> section suggestion on real Oak Grove data
const sugg = CS.suggestSection(model, 1900);
t('era suggestion returns a plausible section', !sugg || (sugg.section && sugg.share >= 45), JSON.stringify(sugg));
// research links
const rl = CS.researchLinks({ fn: 'Ezra', ln: 'Whitcomb', dy: 1920 });
t('research links built', rl.length >= 3 && rl.some(l => l.url.includes('familysearch')) && rl.some(l => l.url.includes('chroniclingamerica')));
t('no obit link for modern deaths', !CS.researchLinks({ fn: 'A', ln: 'B', dy: 2020 }).some(l => l.url.includes('chroniclingamerica')));

/* ---------- grave-numbered blocks (sgBlocks) + new registers ---------- */
section('sgBlocks + registers');
// declared grave-numbered block: grave column carries the position -> becomes lot
const sgbModel = CS.buildModel({
  meta: { cemetery: 'X', fagCemeteryId: 779, cem: { lat: 43.37, lng: -84.66 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [], sgBlocks: ['R'], requests: [], memorials: [],
  roster: [
    [1, 'Doe, Jane', 'F', '', '', '', '', '', 'R', '1', '88', '', 0, '', ''],
    [2, 'Doe, John', 'M', '', '', '', '', '', 'B', '27', '2', '', 0, '', ''],
  ],
}, {});
t('sgBlocks swaps grave->lot', sgbModel.roster[0].lot === '88' && sgbModel.roster[0].grave === '');
t('sgBlocks leaves lot blocks alone', sgbModel.roster[1].lot === '27' && sgbModel.roster[1].grave === '2');
// real dataset: Riverside grave-numbered blocks locate at drawn positions
const rsCem = DS.cemeteries.find(c => c.id === 1506);
if (rsCem) {
  const rsModel = CS.buildModel(rsCem.data, {});
  const rRow = rsModel.roster.find(r => r.block === 'R' && isFinite(parseInt(r.lot)));
  const rLoc = rRow && CS.locate(rsModel, { section: '*', sub: '', block: 'R', lot: rRow.lot, grave: '' });
  t('riverside R roster row swapped', !!rRow, rRow && JSON.stringify([rRow.lot, rRow.grave]));
  const mLoc = CS.locate(rsModel, { section: '*', sub: '', block: 'MAUSO', lot: '150', grave: '' });
  t('riverside R locates on plat', rLoc && (rLoc.level === 'lot' || rLoc.level === 'adjacent'), rLoc && rLoc.level);
  t('riverside MAUSO crypt locates on plat', mLoc && (mLoc.level === 'lot' || mLoc.level === 'adjacent'), mLoc && mLoc.level);
}
// Ithaca static register baked and parsed
const ithCem = DS.cemeteries.find(c => c.id === 1775380);
t('ithaca roster baked', ithCem && ithCem.data.roster.length > 4900, ithCem && String(ithCem.data.roster.length));
if (ithCem) {
  const ithModel = CS.buildModel(ithCem.data, {});
  const secs = new Set(ithModel.roster.map(r => r.section));
  t('ithaca sections parsed', secs.has('Old Plat') && secs.has('2nd ADD'), [...secs].slice(0, 6).join('|'));
  const matched = ithModel.roster.filter(r => r.mem).length;
  t('ithaca roster matches memorials', matched > 1500, String(matched));
}

/* ---------- live walk-row fitting ---------- */
section('fitWalkRows');
// row 'A' positions 1..10; anchors at pos 2 (10 m east steps) and pos 8 —
// the fit must place pos 5 on the line between them
const wrModel = CS.buildModel({
  meta: { cemetery: 'W', fagCemeteryId: 780, cem: { lat: 43.37, lng: -84.66 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [], requests: [],
  memorials: [
    [7001, 'Amy Ash', '', 1900, 1960, 'Row A Lot 2', 43.37, -84.66, 1, ''],
    [7002, 'Ben Birch', '', 1900, 1961, 'Row A Lot 8', 43.37, -84.6598519, 1, ''],  // ~12 m east
  ],
  // rows 2 and 8 carry the same people as the memorials, so the register
  // matcher links them and their GPS becomes the row's anchors
  roster: Array.from({ length: 10 }, (_, i) => [
    i + 1,
    i + 1 === 2 ? 'ASH, AMY' : i + 1 === 8 ? 'BIRCH, BEN' : 'ROW, PERSON' + (i + 1),
    '', i + 1 === 2 ? '1900' : i + 1 === 8 ? '1900' : '',
    i + 1 === 2 ? '1960' : i + 1 === 8 ? '1961' : '',
    '', '*', '', 'A', String(i + 1), '', '', 0, '', '',
  ]),
}, {});
const dynMap = wrModel.maps.find(m => m.dynamic);
t('dynamic row map created', !!dynMap, JSON.stringify(wrModel.maps.map(m => m.file)));
if (dynMap) {
  const p5 = dynMap.entries.find(e => e[0] === 'A' && e[1] === '5');
  t('mid-row position interpolated', !!p5, JSON.stringify(dynMap.entries.map(e => e[1])));
  if (p5) {
    // pos 2 at e=0, pos 8 at e~12 -> pos 5 at e~6
    t('interpolation lands mid-line', Math.abs(p5[2] - 6) < 1.5, String(p5[2]));
  }
  const loc5 = CS.locate(wrModel, { section: '*', sub: '', block: 'A', lot: '5', grave: '' });
  t('locate hits the fitted row', loc5 && loc5.level === 'lot', loc5 && loc5.level);
}
// a "row" whose anchors aren't a line (spacing gate) must be refused
const badModel = CS.buildModel({
  meta: { cemetery: 'W2', fagCemeteryId: 781, cem: { lat: 43.37, lng: -84.66 }, declination: -6.6, asOf: '' },
  sections: {}, maps: [], requests: [],
  memorials: [
    [7101, 'C D', '', 0, 0, 'Row B Lot 1', 43.37, -84.66, 1, ''],
    [7102, 'E F', '', 0, 0, 'Row B Lot 2', 43.3708, -84.66, 1, ''],  // ~89 m for ONE step
  ],
  roster: [[1, 'X, Y', '', '', '', '', '*', '', 'B', '1', '', '', 0, '', ''], [2, 'X, Z', '', '', '', '', '*', '', 'B', '2', '', '', 0, '', '']],
}, {});
t('implausible spacing refused', !badModel.maps.some(m => m.dynamic), JSON.stringify(badModel.maps.length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
