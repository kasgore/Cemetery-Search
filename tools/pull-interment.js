// Pull an interment.net transcription into the app's roster-row format.
// Usage: node pull-interment.js  (Ithaca transcription 1211, 50 pages)
// Output: seed/roster-1775380.json — rows [key, "LAST, FIRST", sex, bd, dd,
// burial, section, sub, block, lot, grave, status, flags, note, formerName],
// plot fields pre-parsed with the app's own CS.parsePlot so roster and
// Find a Grave plots bucket identically.
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const CS = require(path.join(APP, 'app-core.js'));

const BASE = 'https://www.interment.net/united-states/michigan/gratiot-county/ithaca/ithaca-cemetery/transcription/1211.php';
const PAGES = 50;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const rows = [];
  let key = 0;
  for (let page = 1; page <= PAGES; page++) {
    const res = await fetch(`${BASE}?page=${page}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) { console.error(`page ${page}: HTTP ${res.status} — stopping`); break; }
    const html = await res.text();
    const entries = html.match(/<div class="record-entry">[\s\S]*?<\/div>/g) || [];
    for (const div of entries) {
      const text = div.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      // "Abbe, Floyd Albert: b. 08/17/2004, d. 12/21/1974, Veteran, Age: 61, bur. 12/23/1974, Plot: Ithaca-L-355-N. 1/2-002"
      const m = text.match(/^(.*?),\s*(.*?):\s*(.*)$/);
      if (!m) continue;
      const [, last, first, rest] = m;
      const bd = (rest.match(/\bb\.\s*([\d/]+)/) || [])[1] || '';
      const dd = (rest.match(/\bd\.\s*([\d/]+)/) || [])[1] || '';
      const bur = (rest.match(/\bbur\.\s*([\d/]+)/) || [])[1] || '';
      const vet = /\bVeteran\b/i.test(rest);
      const plotRaw = (rest.match(/Plot:\s*(.+)$/) || [])[1] || '';
      const p = CS.parsePlot(plotRaw, 'generic') || { section: '', sub: '', block: '', lot: '', grave: '' };
      rows.push([
        ++key, `${last.toUpperCase()}, ${first.toUpperCase()}`, '', bd, dd, bur,
        p.section, p.sub, p.block, p.lot, p.grave,
        '', vet ? 4 : 0, '', '',
      ]);
    }
    if (page % 10 === 0 || page === 1) console.log(`page ${page}: ${rows.length} records so far`);
    await sleep(600);
  }
  const out = path.join(APP, 'seed', 'roster-1775380.json');
  fs.writeFileSync(out, JSON.stringify(rows));
  fs.writeFileSync(path.join(APP, 'data', 'cem', '1775380-roster.json'), JSON.stringify(rows));
  console.log(`wrote ${rows.length} roster rows -> seed/ and data/cem/`);
  // section histogram as a sanity check
  const secs = {};
  for (const r of rows) secs[r[6] || '(none)'] = (secs[r[6] || '(none)'] || 0) + 1;
  console.log('sections:', JSON.stringify(secs));
})();
