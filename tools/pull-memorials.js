// One-time, human-paced pull of the Oak Grove (FAG cemetery 1252) memorial list.
// 100 records/page, ~2s between requests, personal-use data for the volunteer's own field app.
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const all = [];
  let total = null;
  for (let skip = 0; total === null || skip < total; skip += 100) {
    const url = `https://www.findagrave.com/cemetery/1252/memorial-search?ajax=true&limit=100&skip=${skip}`;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        total = data.total;
        const batch = data.collection || data.memorials || [];
        all.push(...batch);
        console.log(`skip=${skip} got=${batch.length} running=${all.length}/${total}`);
        if (batch.length === 0) { skip = total; } // safety: stop if empty page
        ok = true;
      } catch (e) {
        console.log(`skip=${skip} attempt ${attempt + 1} failed: ${e.message}`);
        await sleep(5000);
      }
    }
    if (!ok) { console.log('giving up at skip=' + skip); break; }
    await sleep(1800 + Math.floor(500 * (skip % 3)));
  }
  fs.writeFileSync('memorials.json', JSON.stringify({ fetchedAt: '2026-07-26', total, records: all }));
  console.log('DONE wrote memorials.json with ' + all.length + ' records');
})();
