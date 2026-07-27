// One-time polite pull of Oak Grove's public burial register from BS&A Online
// (City of St. Louis MI, uid=2024). Occupant records: RecordKeyType=10 / ReferenceType=6,
// sequential RecordKeys ~1..10500 (sparse tail). ~300ms pacing, resumable via JSONL.
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const OUT = 'bsa-records.jsonl';
const MAX_KEY = 10500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).key); } catch {}
  }
}
console.log('already done:', done.size);

function parsePairs(html) {
  const pairs = [...html.matchAll(/label-value-row-label">([^<]*)<\/div><div role="cell" class="label-value-row-value">([^<]*)</g)]
    .map(m => [m[1].trim(), m[2].replace(/&nbsp;?/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim()]);
  const rec = {};
  const KEEP = ['Name', 'Former Name', 'Sex', 'Birth Date', 'Burial Date', 'Death Date', 'Age', 'Resident', 'Veteran',
    'Service Branch', 'Era', 'Birth Place', 'Place of Death', 'Funeral Home', 'Burial Type', 'Notes',
    'Buriel at Foot', 'Buriel at head', 'User 3', 'Plot Number', 'Section', 'Block', 'Lot', 'Plot', 'Status',
    'Number of Occupants'];
  const names = [];
  for (const [label, valueRaw] of pairs) {
    let value = valueRaw === label ? '' : valueRaw; // BS&A renders empty values as the label text sometimes
    if (!label) continue;
    if (label === 'Name') { names.push(value); if (!('Name' in rec)) rec.Name = value; continue; }
    if (KEEP.includes(label) && !(label in rec)) rec[label] = value;
  }
  if (names.length > 1) rec.otherNames = names.slice(1).filter(n => n && n !== rec.Name);
  return rec;
}

(async () => {
  let hits = 0, misses = 0, errors = 0, consecErrors = 0;
  const retries = {};
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  for (let K = 1; K <= MAX_KEY; K++) {
    if (done.has(K)) continue;
    try {
      const pdUrl = `https://www.bsaonline.com/SiteSearch/PropertyDetails?uid=2024&RecordKey=${K}&RecordKeyType=10&ReferenceKey=${K}&ReferenceType=6&SearchFocus=Cemetery%20Management&SearchCategory=Name&SearchText=x&PageIndex=1`;
      const r1 = await fetch(pdUrl, { headers: { 'User-Agent': UA } });
      if (!r1.ok) throw new Error('pd http ' + r1.status);
      const cookies = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
      const html1 = await r1.text();
      const m = html1.match(/LoadContent[^"']*/);
      if (!m) {
        out.write(JSON.stringify({ key: K, miss: true }) + '\n');
        misses++; consecErrors = 0;
        await sleep(150);
        continue;
      }
      const lcUrl = 'https://www.bsaonline.com/CemeterySearch/' + m[0].replace(/&amp;/g, '&');
      const r2 = await fetch(lcUrl, { headers: { 'User-Agent': UA, 'Cookie': cookies, 'Referer': pdUrl } });
      if (!r2.ok) throw new Error('lc http ' + r2.status);
      const html2 = await r2.text();
      const rec = parsePairs(html2);
      rec.key = K;
      if (!rec.Name && !rec['Plot Number']) { rec.miss = true; misses++; } else hits++;
      out.write(JSON.stringify(rec) + '\n');
      consecErrors = 0;
      if ((hits + misses) % 200 === 0) console.log(`K=${K} hits=${hits} misses=${misses} errors=${errors}`);
    } catch (e) {
      errors++; consecErrors++;
      console.log(`K=${K} error: ${e.message}`);
      if (consecErrors >= 8) { console.log('too many consecutive errors — backing off 5 min'); await sleep(300000); consecErrors = 0; }
      else await sleep(3000);
      retries[K] = (retries[K] || 0) + 1;
      if (retries[K] <= 2) K--; // retry this key up to twice
      else out.write(JSON.stringify({ key: K, miss: true, error: e.message }) + '\n');
      if (errors > 400) { console.log('error budget exhausted, stopping'); break; }
    }
    await sleep(280 + Math.floor(Math.random() * 140));
  }
  out.end();
  console.log(`DONE hits=${hits} misses=${misses} errors=${errors}`);
})();
