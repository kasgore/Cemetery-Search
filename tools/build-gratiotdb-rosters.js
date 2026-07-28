// Convert the Gratiot County Cemeteries Online database (mfhn.com grid,
// mirrored at gratiot.migenweb.org, crawled to gratiotdb-rows.json) into
// per-cemetery roster seeds. Also converts the Chippewa Twp 1941 sexton
// records (isabella.migenweb.org/chippewa_sexton.html -> chippewa-sexton.html).
//
// Row source columns: [Surname, Given, Middle, Maiden, Birth, Death, Age,
//   Relative, Inscription, Notes, Cemetery, Township, Plot, Map_No]
// Positional encodings:
//   Pritchard   Map_No "S1-R17-19"  -> Section 1, Row 17, position 19
//   Elm Hall    Map_No "02-13-03"   -> section 2, row 13, position 3
//   St.Patricks Map_No "02-cz-57"   -> section 2, row CZ, position 57
//   Riverdale   Plot   "R 16-03"    -> lot 16, grave 3
//   Seville-Fr  Plot   "SC 65-01"   -> lot 65, grave 1
//   Brady       Plot   "B38-2"      -> lot 38, grave 2
//   Sibley      Plot   "S23" / "S Col 6 G" -> lot 23 / block COL6 position G
// Run from a directory containing gratiotdb-rows.json and chippewa-sexton.html.
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');

const rows = JSON.parse(fs.readFileSync('gratiotdb-rows.json', 'utf8'));

function plotFor(cem, plot, mapno) {
  const P = (plot || '').trim(), M = (mapno || '').trim();
  let m;
  if (cem === 'Pritchard') {
    if ((m = M.match(/^S(\d+)-R(\d+)-(\d+)[ab]?$/i)))
      return { section: 'Section ' + +m[1], block: String(+m[2]), lot: String(+m[3]), grave: '' };
    return null;
  }
  if (cem === 'Elm Hall') {
    if ((m = M.match(/^(\d+)-(\d+)-(\d+)$/)))
      return { section: 'Section ' + +m[1], block: String(+m[2]), lot: String(+m[3]), grave: '' };
    return null;
  }
  if (cem === 'St. Patricks-Irishtown') {
    if ((m = M.match(/^(\d+)-([a-z]+|\d+)-(\d+)$/i)))
      return { section: 'Section ' + +m[1], block: String(m[2]).toUpperCase().replace(/^0+(?=\d)/, ''), lot: String(+m[3]), grave: '' };
    return null;
  }
  if (cem === 'Riverdale') {
    if ((m = P.match(/^R\s*-?(\d+)(?:--?(\d+))?$/)))
      return { section: '*', block: '', lot: String(+m[1]), grave: m[2] ? String(+m[2]) : '' };
    return null;
  }
  if (cem === 'Seville - French') {
    if ((m = P.match(/^SC\s*(\d+)(?:-(\d+))?$/)))
      return { section: '*', block: '', lot: String(+m[1]), grave: m[2] ? String(+m[2]) : '' };
    return null;
  }
  if (cem === 'Brady') {
    if ((m = P.match(/^B(\d+)-(\d+)$/)))
      return { section: '*', block: '', lot: String(+m[1]), grave: String(+m[2]) };
    return null;
  }
  if (cem === 'Sibley-Welch') {
    if ((m = P.match(/^S\s*Col\s*(\d+)\s*([A-Z]?)$/i)))
      return { section: '*', block: 'COL' + m[1], lot: m[2] || '', grave: '' };
    if ((m = P.match(/^S(\d+)$/))) return { section: '*', block: '', lot: String(+m[1]), grave: '' };
    return null;
  }
  return null;
}

const CEM_ID = {
  'Pritchard': 1434, 'Riverdale': 1491, 'Elm Hall': 445, 'Seville - French': 2257472,
  'St. Patricks-Irishtown': 2357025, 'Brady': 154, 'Sibley-Welch': 1747,
};

const byCem = {};
for (const r of rows) {
  const cid = CEM_ID[r[10]];
  if (!cid) continue;
  (byCem[cid] = byCem[cid] || []).push(r);
}
for (const [cid, list] of Object.entries(byCem)) {
  const out = [];
  let key = 0, located = 0;
  for (const r of list) {
    const [sur, given, middle, maiden, birth, death, , relative, inscr, notes, cem] = r;
    if (!sur && !given) continue;
    const p = plotFor(cem, r[12], r[13]);
    if (p) located++;
    const name = `${(sur || '?').toUpperCase()}, ${[given, middle].filter(Boolean).join(' ').toUpperCase()}`;
    const note = [relative, inscr, notes].filter(Boolean).join(' · ').slice(0, 160);
    out.push([
      ++key, name, '', birth || '', death || '', '',
      p ? p.section : '', '', p ? p.block : '', p ? p.lot : '', p ? p.grave : '',
      '', 0, note, maiden || '',
    ]);
  }
  fs.writeFileSync(path.join(APP, 'seed', `roster-${cid}.json`), JSON.stringify(out));
  fs.writeFileSync(path.join(APP, 'data', 'cem', `${cid}-roster.json`), JSON.stringify(out));
  console.log(`${cid} (${list[0][10]}): ${out.length} rows, ${located} with position (${Math.round(100 * located / out.length)}%)`);
}

/* ---- Lee Twp Cemetery (midland.migenweb.org/lee.html): walk-order
   transcription with SECTION ONE/TWO/THREE headers and "Row one..eight"
   markers; each line between markers is one burial in reading order, so
   section-row-position is real spatial data (the Pritchard lesson). ---- */
if (fs.existsSync('lee-cemetery.html')) {
  const html = fs.readFileSync('lee-cemetery.html', 'utf8');
  const lines = html.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const out = [];
  let key = 0, section = 0, row = 0, pos = 0;
  for (const l of lines) {
    let m;
    if ((m = l.match(/^SECTION\s+(\w+)/i)) && WORDNUM[m[1].toLowerCase()]) { section = WORDNUM[m[1].toLowerCase()]; row = 0; continue; }
    if ((m = l.match(/^Row\s+(\w+)/i)) && WORDNUM[m[1].toLowerCase()]) { row = WORDNUM[m[1].toLowerCase()]; pos = 0; continue; }
    if (!section || !row) continue;
    if (/©|copyright|return to|migenweb|transcribed/i.test(l)) continue;
    // "Schaefer, Alfred A.  1924 - 1960 (burial Apr. 25)" | "Davis, Linda  1939"
    m = l.match(/^([A-Z][A-Za-z' .()-]*?),\s*(.+)$/);
    if (!m) continue;
    pos++;
    const last = m[1];
    const restAll = m[2];
    const firstYear = restAll.search(/\b(?:1[6-9]|20)\d\d\b/);
    const given = (firstYear >= 0 ? restAll.slice(0, firstYear) : restAll).replace(/[-–\s]+$/, '').trim();
    const years = restAll.match(/\b(?:1[6-9]|20)\d\d\b/g) || [];
    const bd = years.length >= 2 ? years[0] : '';
    const dd = years.length ? years[years.length - 1] : '';
    const lastYearEnd = years.length ? restAll.lastIndexOf(years[years.length - 1]) + 4 : given.length;
    const note = restAll.slice(lastYearEnd).replace(/^[()\s-]+|[()\s]+$/g, '');
    out.push([
      ++key, `${last.toUpperCase()}, ${given.toUpperCase()}`, '', bd, dd, '',
      'Section ' + section, '', String(row), String(pos), '',
      '', 0, note.slice(0, 120), '',
    ]);
  }
  fs.writeFileSync(path.join(APP, 'seed', 'roster-159973.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(APP, 'data', 'cem', '159973-roster.json'), JSON.stringify(out));
  console.log(`159973 (Lee Twp walk-order): ${out.length} rows`);
}

/* ---- Chippewa Twp 1941 sexton records: NAME / ROW / LOT triplets ---- */
{
  const html = fs.readFileSync('chippewa-sexton.html', 'utf8');
  const lines = html.replace(/<[^>]+>/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
  const start = lines.findIndex(l => l === 'LOT NO') + 1;
  const out = [];
  let key = 0, cur = null;
  // a "name" line has a comma (SURNAME, Given) or is a bare all-caps surname;
  // stray annotation lines ("County Ch.", "[removed]") attach to the record
  const isName = l => /^[A-Z][A-Za-z' .-]*,/.test(l) || /^[A-Z][A-Z' -]{2,}$/.test(l);
  const flush = () => {
    if (!cur || !cur.name) return;
    out.push([
      ++key, cur.name.toUpperCase(), '', '', '', '',
      '*', '', cur.row || '', cur.lot || '', '',
      '', 0, ('sexton record 1941' + (cur.note ? ' · ' + cur.note : '')).slice(0, 120), '',
    ]);
  };
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (/©|copyright|return to|isabella county/i.test(l)) break;
    if (isName(l)) { flush(); cur = { name: l, row: '', lot: '', note: '' }; }
    else if (cur && !cur.row && /^[A-Z]$/i.test(l)) cur.row = l.toUpperCase();
    else if (cur && cur.row && !cur.lot && /^[0-9][0-9A-Za-z/ .]*$/.test(l)) cur.lot = l.replace(/[^0-9]/g, '');
    else if (cur) cur.note = (cur.note ? cur.note + ' ' : '') + l;
  }
  flush();
  fs.writeFileSync(path.join(APP, 'seed', 'roster-159825.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(APP, 'data', 'cem', '159825-roster.json'), JSON.stringify(out));
  console.log(`159825 (Chippewa Twp 1941 sexton): ${out.length} rows`);
}
