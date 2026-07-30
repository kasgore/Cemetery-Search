/* ==========================================================
   Cemetery Search — UI layer (DOM, sensors, storage).
   Multi-cemetery: window.CEMDATA (v2) with legacy OAKGROVE fallback.
   ========================================================== */
(function () {
'use strict';

const STORE_KEY = 'cemsearch_v3';            // progress + prefs (small, precious)
const UPDATES_KEY = 'cemsearch_v3_updates';  // bulk dataset updates (large, re-downloadable)
const $ = id => document.getElementById(id);

/* ---------------- persistent state ---------------- */
let store = { progress: {}, updates: {}, prefs: {} };
try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      store.progress = (parsed.progress && typeof parsed.progress === 'object') ? parsed.progress : {};
      store.prefs = (parsed.prefs && typeof parsed.prefs === 'object') ? parsed.prefs : {};
    }
  }
} catch (e) { /* ignore */ }
try {
  const rawU = localStorage.getItem(UPDATES_KEY);
  if (rawU) {
    const u = JSON.parse(rawU);
    if (u && typeof u === 'object') store.updates = u;
  }
} catch (e) { /* ignore */ }

let saveTimer = null;
function writeProgress() {
  localStorage.setItem(STORE_KEY, JSON.stringify({ progress: store.progress, prefs: store.prefs }));
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { writeProgress(); }
  catch (e) { toast('⚠ Could not save progress (storage full?) — use Export progress now'); }
}
function saveUpdates() {
  try { writeProgress(); } catch (e) { /* progress first, always */ }
  try { localStorage.setItem(UPDATES_KEY, JSON.stringify(store.updates)); }
  catch (e) {
    // storage full: drop the bulkiest re-downloadable pieces and retry
    const slim = {};
    for (const [cid, u] of Object.entries(store.updates)) {
      slim[cid] = Object.assign({}, u);
      delete slim[cid].memorials; delete slim[cid].memorialsAsOf;
    }
    try {
      localStorage.setItem(UPDATES_KEY, JSON.stringify(slim));
      store.updates = slim;
      toast('⚠ Storage full — memorial updates not kept (they re-download automatically)');
    } catch (e2) { toast('⚠ Storage full — dataset update could not be saved'); }
  }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

/* ---------------- dataset + models ---------------- */
const DS = CS.normalizeDataset(window.CEMDATA || window.OAKGROVE || null);
const gproj = CS.makeProj(DS.home);
const cemById = new Map(DS.cemeteries.map(c => [String(c.id), c]));

// migrate legacy single-cemetery updates shape — the legacy app was Oak Grove (1252)
// only; if the dataset failed to load, leave the stored shape untouched for next boot
if (store.updates && (store.updates.requests || store.updates.memorials || store.updates.roster)) {
  if (cemById.has('1252')) {
    store.updates = { '1252': store.updates };
    saveUpdates();
  } else if (DS.cemeteries.length) {
    store.updates = { [String(DS.cemeteries[0].id)]: store.updates };
    saveUpdates();
  }
}

/* field-log backup: progress (finds/notes/GPS pins) mirrors to the server so
   a lost phone or an evicted browser cache never loses a find. Per-grave
   newest-ts merge on both ends — multiple devices stay consistent. On static
   hosting (no /api) the fetch just fails and everything stays local-only. */
let syncTimer = null;
function scheduleProgressSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncProgress, 4000); }
/* connection chip: says plainly whether the Pi is reachable and how much
   work is waiting, so "it didn't upload" is never a silent failure */
let linkOk = null;
async function updateLinkChip() {
  const el = document.getElementById('link-chip');
  if (!el) return;
  let queued = 0;
  try {
    for (const pk of await photoDB.keys()) {
      const rec = await photoDB.get(pk);
      if (rec && !rec.synced) queued++;
    }
  } catch (e) { /* ignore */ }
  if (linkOk === false) {
    el.className = 'show off';
    el.textContent = queued ? `⚠ no server · ${queued} photo${queued > 1 ? 's' : ''} waiting` : '⚠ no server link';
    el.title = 'The app can\'t reach the Pi right now. Marks and photos are saved on this device and will sync automatically when it can.';
  } else if (photoFailures && queued) {
    // the server is reachable but refusing the upload — say so, because a
    // silent retry loop is how a photo goes missing without anyone noticing
    el.className = 'show off';
    el.textContent = `⚠ ${queued} photo${queued > 1 ? 's' : ''} rejected — still on this device`;
    el.title = 'The Pi refused these uploads. They are safe here; tell Claude so the cause can be fixed.';
  } else if (queued) {
    el.className = 'show ok';
    el.textContent = `⇅ ${queued} photo${queued > 1 ? 's' : ''} syncing`;
    el.title = 'Photos are uploading to the Pi.';
  } else {
    el.className = '';
    el.textContent = '';
  }
}
async function syncProgress() {
  const el = document.getElementById('sync-status');
  try {
    const res = await fetch('./api/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress: store.progress }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const merged = (await res.json()).progress || {};
    let adopted = 0, adoptedGps = false;
    for (const [pk, v] of Object.entries(merged)) {
      const mine = store.progress[pk];
      if (!mine || (v.ts || 0) > (mine.ts || 0)) {
        store.progress[pk] = v; adopted++;
        if (v.gps) adoptedGps = true;
      }
    }
    if (adopted) {
      // full cross-device sync: changes made on the other device show up in
      // whatever view is open, not just after a reload
      save(); updateStats();
      if (adoptedGps) models.clear();   // pins change anchors + row fits — rebuild
      const active = document.querySelector('.panel.active');
      if (active && active.id === 'panel-walk') renderWalk();
      if (active && active.id === 'panel-queue') renderQueue();
      // any adopted change repaints the map: an anchor moves dots, an outcome
      // recolours its pin — the other person's work should appear without
      // anyone thinking to reload
      if (active && active.id === 'panel-map' && mainMap) refreshMapLayers();
      if (guideTarget && guideTarget.pk) { syncGuideButtons(); renderGuidePhoto(); }
      if (guideMap && guideModel && guideTarget) {
        guideMap.layers = buildLayers([String(guideModel.cem.id)], guideTarget);
        guideMap.draw();
      }
    }
    const n = Object.values(store.progress).filter(p => p.st || p.note || p.gps || p.photo || p.up).length;
    if (el) el.textContent = `☁ field log synced with the Pi — ${n} entr${n === 1 ? 'y' : 'ies'}`;
    linkOk = true;
  } catch (e) {
    linkOk = false;
    if (el) el.textContent = '⚠ can\'t reach the Pi — everything is saved on this device and will sync when the link is back';
  }
  updateLinkChip();
}
setTimeout(syncProgress, 2500);        // boot: pull the server copy and merge
setInterval(syncProgress, 60000);      // steady heartbeat — phone and PC converge within a minute
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncProgress(); syncPhotos(); } });

/* field photos: reference copies so a day's shots match their graves.
   Local-first in IndexedDB (works in dead zones), synced to the server
   whenever it's reachable — over Tailscale that's usually within seconds. */
const photoDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('cemsearch-photos', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('photos');
      rq.onsuccess = () => { this._db = rq.result; res(this._db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async put(pk, rec) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').put(rec, pk);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async get(pk) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const rq = db.transaction('photos').objectStore('photos').get(pk);
      rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error);
    });
  },
  async del(pk) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('photos', 'readwrite');
      tx.objectStore('photos').delete(pk);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async keys() {
    const db = await this.open();
    return new Promise((res, rej) => {
      const rq = db.transaction('photos').objectStore('photos').getAllKeys();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
  },
};
// re-encode at a size cap; used for thumbnails (the FULL-RES original is
// what queues for the Pi — Find a Grave deserves the real photo)
function shrinkPhoto(file, maxDim, quality) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, (maxDim || 1600) / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      cv.toBlob(b => b ? res(b) : rej(new Error('encode failed')), 'image/jpeg', quality || 0.82);
    };
    img.onerror = () => rej(new Error('not an image'));
    img.src = URL.createObjectURL(file);
  });
}
// Trust the BYTES, not the file's declared type. iPhones shoot HEIC and iOS
// file inputs sometimes report an empty MIME type, so a "looks like a photo"
// check would hand the server a HEIC it must reject — and the upload would
// retry forever in silence. Anything that isn't a real JPEG gets re-encoded.
async function ensureJpeg(blob) {
  try {
    const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
    if (head[0] === 0xFF && head[1] === 0xD8) return blob;      // already JPEG
  } catch (e) { /* fall through to re-encode */ }
  return shrinkPhoto(blob, 4000, 0.92);
}
// sync loop built for intermittent cell service: full-res photos wait in
// IndexedDB across restarts, a retry timer + the 'online' event keep nudging,
// and after a confirmed upload the phone keeps only the thumbnail
let photoSyncBusy = false;
let photoFailures = 0;
async function syncPhotos() {
  if (photoSyncBusy) return;
  photoSyncBusy = true;
  let pending = 0;
  try {
    for (const pk of await photoDB.keys()) {
      const rec = await photoDB.get(pk);
      if (!rec || rec.synced) continue;
      try {
        // a queued blob may predate the JPEG check (HEIC from an older
        // build) — convert on the way out rather than retrying forever
        const body = await ensureJpeg(rec.blob);
        const res = await fetch('./api/photo/' + encodeURIComponent(pk), {
          method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body,
        });
        if (!res.ok) {
          pending++;
          if (res.status >= 400 && res.status < 500) photoFailures++;   // server refused it
          continue;
        }
        photoFailures = 0;
        // the server may have moved this shot to a free slot (another device
        // already used ours) — put the thumbnail with wherever it landed
        let serverKey = pk;
        try { const j = await res.json(); if (j && j.key) serverKey = j.key; } catch (e) { /* older server */ }
        if (rec.thumb) {
          await fetch('./api/photo/' + encodeURIComponent(serverKey) + '?thumb=1', {
            method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: rec.thumb,
          }).catch(() => {});
        }
        // uploaded — drop the big blob, keep the thumb for instant display
        await photoDB.put(pk, { thumb: rec.thumb || null, ts: rec.ts, synced: true });
        if (guideTarget && guideTarget.pk === pk) renderGuidePhoto();
      } catch (e) { pending++; }
    }
  } catch (e) { /* IndexedDB unavailable — nothing to do */ }
  photoSyncBusy = false;
  updateLinkChip();
  if (pending) setTimeout(syncPhotos, 60000);   // keep nudging till it's all up
}
setTimeout(syncPhotos, 3500);
window.addEventListener('online', () => setTimeout(syncPhotos, 1500));

const models = new Map();
function getModel(cemId) {
  cemId = String(cemId);
  if (models.has(cemId)) return models.get(cemId);
  const cem = cemById.get(cemId);
  if (!cem) return null;
  let model;
  const fieldGps = {};
  for (const [pk, p] of Object.entries(store.progress)) if (p.gps) fieldGps[pk] = p.gps;
  try {
    model = CS.buildModel(cem.data, Object.assign({}, store.updates[cemId] || {}, { fieldGps }));
  } catch (e) {
    console.error('buildModel failed for', cem.name, e);
    delete store.updates[cemId];
    saveUpdates();
    try { model = CS.buildModel(cem.data, {}); }
    catch (e2) { return null; }
    setTimeout(() => toast('⚠ A stored update for ' + cem.name + ' was corrupt and was discarded'), 400);
  }
  model.cem = cem;
  models.set(cemId, model);
  return model;
}
function builtModels() { return [...models.values()]; }
function ensureAllModels() { for (const c of DS.cemeteries) getModel(c.id); return builtModels(); }

// idle prebuild so search/map are instant by the time they're used
(function idleBuild(i) {
  if (i >= DS.cemeteries.length) { updateStats(); return; }
  setTimeout(() => { getModel(DS.cemeteries[i].id); idleBuild(i + 1); }, 30);
})(0);

function activeCem() {
  const v = store.prefs.activeCem;
  return (v && v !== 'all' && cemById.has(String(v))) ? String(v) : 'all';
}
function activeCemList() {
  const a = activeCem();
  return a === 'all' ? DS.cemeteries.map(c => String(c.id)) : [a];
}

function progressOf(pk) { return store.progress[pk] || {}; }
function setProgress(pk, patch) {
  const merged = Object.assign({}, store.progress[pk] || {}, patch, { ts: Date.now() });
  // an emptied entry becomes a timestamped tombstone (not a delete) so
  // un-marking a grave propagates through the server backup instead of the
  // old state syncing back
  if (!merged.st && !merged.note && !merged.gps && !merged.photo && !merged.up) store.progress[pk] = { ts: merged.ts };
  else store.progress[pk] = merged;
  save();
  scheduleProgressSync();
  updateStats();
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms || 2600);
}

/* ---------------- GPS ---------------- */
const geo = {
  watchId: null, pos: null, err: null, listeners: new Set(),
  on() {
    if (this.watchId != null || !navigator.geolocation) return;
    this.watchId = navigator.geolocation.watchPosition(
      p => {
        this.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, heading: p.coords.heading, speed: p.coords.speed, ts: p.timestamp };
        this.err = null;
        gpsChip();
        this.listeners.forEach(f => f(this.pos));
      },
      e => {
        this.err = e;
        gpsChip();
        if (location.protocol === 'file:' || (typeof isSecureContext !== 'undefined' && !isSecureContext)) {
          toast('GPS needs HTTPS — open the https:// address and accept the certificate warning once.');
        } else if (e.code === 1) toast('GPS permission denied. Allow location for this site.');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    gpsChip();
  },
  off() {
    if (this.watchId != null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    gpsChip();
  },
  toggle() { this.watchId == null ? this.on() : this.off(); },
};
function gpsChip() {
  const el = $('gps-chip');
  if (geo.watchId == null) { el.textContent = 'GPS off'; el.className = ''; }
  else if (geo.err) { el.textContent = 'GPS error'; el.className = 'err'; }
  else if (!geo.pos) { el.textContent = 'GPS…'; el.className = ''; }
  else { el.textContent = 'GPS ' + fmtAcc(geo.pos.acc); el.className = 'on'; }
}

/* ---------------- compass ---------------- */
const compass = {
  heading: null, raw: null, active: false, declination: -6.6, listeners: new Set(),
  async enable() {
    if (this.active) return true;
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') { toast('Compass permission denied'); return false; }
      }
    } catch (e) { /* non-iOS or blocked */ }
    const handler = ev => {
      let h = null;
      if (ev.webkitCompassHeading != null && isFinite(ev.webkitCompassHeading)) h = ev.webkitCompassHeading;
      else if (ev.absolute === true && ev.alpha != null) h = (360 - ev.alpha) % 360;
      else if (ev.type === 'deviceorientationabsolute' && ev.alpha != null) h = (360 - ev.alpha) % 360;
      if (h == null) return;
      const angle = (screen.orientation && typeof screen.orientation.angle === 'number')
        ? screen.orientation.angle
        : (typeof window.orientation === 'number' ? window.orientation : 0);
      h = (h + angle + 360) % 360;
      h = (h + this.declination + 360) % 360; // magnetic -> true
      this.raw = h;
      if (this.heading == null) this.heading = h;
      else {
        const d = ((h - this.heading + 540) % 360) - 180;
        this.heading = (this.heading + d * 0.25 + 360) % 360;
      }
      this.listeners.forEach(f => f(this.heading));
    };
    if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', handler);
    else window.addEventListener('deviceorientation', handler);
    this.active = true;
    return true;
  },
  best() {
    if (this.heading != null) return { h: this.heading, src: 'compass' };
    if (geo.pos && geo.pos.heading != null && isFinite(geo.pos.heading) && geo.pos.speed > 0.7) return { h: geo.pos.heading, src: 'gps-course' };
    return null;
  },
};

/* ---------------- wake lock ---------------- */
let wakeLock = null;
async function wakeOn() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ok */ }
}
function wakeOff() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('guide').classList.contains('open')) wakeOn();
});

/* ---------------- cemetery selector ---------------- */
function renderCemSelect() {
  const sel = $('cem-select');
  const cur = activeCem();
  sel.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  const totalReq = DS.cemeteries.reduce((s, c) => s + requestRowsFor(c).length, 0);
  optAll.textContent = `All nearby — ${DS.cemeteries.length} cemeteries, ${totalReq} requests`;
  sel.appendChild(optAll);
  for (const c of DS.cemeteries) {
    const o = document.createElement('option');
    o.value = String(c.id);
    o.textContent = `${c.name} — ${requestRowsFor(c).length} req${c.miles != null ? ' · ' + c.miles + ' mi' : ''}`;
    sel.appendChild(o);
  }
  sel.value = cur;
}
document.addEventListener('change', ev => {
  if (ev.target && ev.target.id === 'cem-select') {
    store.prefs.activeCem = ev.target.value;
    save();
    renderWalk();
    if ($('panel-map').classList.contains('active')) { refreshMapLayers(); fitMap(); }
  }
});

/* ---------------- tabs ---------------- */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'walk') renderWalk();
  if (name === 'map') { ensureMap(); mainMap.resize(); refreshMapLayers(); fitMap(); }
  if (name === 'search') ensureAllModels(); // pay the build cost on tab open, not first keystroke
  if (name === 'queue') renderQueue();
  if (name === 'data') renderDataInfo();
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

/* ---------------- stats ---------------- */
// effective request rows for a cemetery, honoring manual snapshot updates
function requestRowsFor(c) {
  const u = store.updates[String(c.id)];
  return (u && Array.isArray(u.requests)) ? u.requests : c.data.requests;
}
function updateStats() {
  let open = 0, done = 0, hereOpen = 0;
  const activeIds = new Set(activeCemList());
  for (const c of DS.cemeteries) {
    const here = activeIds.has(String(c.id));
    for (const r of requestRowsFor(c)) {
      const st = progressOf(r.mid).st;
      if (st === 'done' || st === 'nostone' || st === 'notfound') done++;
      else { open++; if (here) hereOpen++; }
    }
  }
  // scoped count when a single cemetery is selected — the header must match the list
  $('stat-open').textContent = activeCem() === 'all' ? open : `${hereOpen} here · ${open}`;
  $('stat-done').textContent = done;
}

/* ---------------- walking list ---------------- */
const OAKGROVE_SECTION_ORDER = ['Vault Hill', 'Round Hill', 'Old Part', 'Square Hill', 'Hofstetter Hill', 'Cutler Hill',
  'Oak Hill', 'Mausoleum', 'Single Grave', 'North Hill', 'Veteran Hill', 'Morris Hill'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const normFilter = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// one vocabulary for confidence levels, everywhere in the app
const LEVEL_LABEL = { gps: 'GPS pin', lot: 'lot position', adjacent: 'near lot', block: 'block area', section: 'section area', family: 'family lot' };
function levelLabel(l) { return LEVEL_LABEL[l] || l; }
/* US units — cemetery work is feet-and-miles territory */
const M_TO_FT = 3.28084;
function fmtDist(m) {
  const ft = m * M_TO_FT;
  if (ft < 1000) return Math.round(ft) + ' ft';
  const mi = m / 1609.344;
  return (mi >= 10 ? Math.round(mi) : mi.toFixed(mi < 2 ? 2 : 1)) + ' mi';
}
function fmtAcc(m) { return '±' + Math.round(m * M_TO_FT) + ' ft'; }

function locChip(req, model) {
  if (!req.loc) {
    const interments = model && model.cem && model.cem.data.meta ? (model.cem.data.memorials.length || 0) : 0;
    const small = interments > 0 && interments <= 400;
    const hasPlotText = req.plot && !/no location|unknown/i.test(req.plot);
    // the register has this person but the cemetery office itself never
    // recorded where — worth saying plainly, so nobody hunts for a plot
    // that was never written down
    const inRegisterNoPlot = req.ros && !req.ros.section;
    const msg = inRegisterNoPlot ? 'in the burial register, but the cemetery has no plot recorded for them'
      : hasPlotText ? 'plot recorded — not mappable yet, tap Neighbors'
      : small ? 'no plot — small cemetery, walkable in full'
      : 'no plot on record — tap Neighbors for family leads';
    return `<span class="loc-chip"><span class="dot q-none"></span>${msg}</span>`;
  }
  const l = req.loc;
  const q = l.level === 'gps' || l.level === 'lot' ? 'q-lot' : (l.level === 'adjacent' || l.level === 'block') ? 'q-block' : 'q-section';
  const pins = l.pins ? ` · ${l.pins} pin${l.pins > 1 ? 's' : ''}` : '';
  const disputed = l.disputed ? ' · pins disagree — check both spots' : '';
  const via = l.level === 'family' && l.via ? ` (${esc(l.via)}'s grave)` : '';
  return `<span class="loc-chip"><span class="dot ${q}"></span>${levelLabel(l.level)} ${fmtAcc(l.acc)}${via}${pins}${disputed}</span>`;
}
function plotLine(req) {
  const bits = [];
  if (req.plot && !/no location/i.test(req.plot)) bits.push(esc(req.plot));
  // show the register plot when Find a Grave has none, they disagree, OR the
  // register adds precision (a lot/grave number the FAG string lacks)
  const rosAdds = req.pRos && req.pFag &&
    ((req.pRos.lot && !req.pFag.lot) || (req.pRos.grave && !req.pFag.grave));
  if (req.pRos && (!req.pFag || req.plotConflict || rosAdds)) {
    const r = req.pRos;
    const secTxt = r.section === '*' ? '' : r.section + (r.sub ? ' Sub ' + r.sub : '');
    bits.push('<span class="badge sky" title="from city burial register">register</span> ' +
      esc([secTxt, r.block && 'Blk ' + r.block, r.lot && 'Lot ' + r.lot, r.grave && 'Grave ' + r.grave].filter(Boolean).join(' ')));
  }
  return bits.join(' &nbsp;·&nbsp; ');
}

function sortRequests(items, sort) {
  const lotOf = r => { const n = parseInt(r.pBest && r.pBest.lot); return isFinite(n) ? n : 9999; };
  const blockOf = r => (r.pBest && r.pBest.block) || '';
  if (sort === 'name') items.sort((a, b) => CS.normName(a.ln).localeCompare(CS.normName(b.ln)));
  else if (sort === 'conf') {
    const rank = { gps: 0, lot: 1, adjacent: 2, block: 3, section: 4, family: 5 };
    items.sort((a, b) => (a.loc ? rank[a.loc.level] : 9) - (b.loc ? rank[b.loc.level] : 9));
  } else if (sort === 'near' && geo.pos) {
    items.sort((a, b) => {
      const da = a.loc ? CS.distM(geo.pos.lat, geo.pos.lng, a.loc.lat, a.loc.lng) : 1e9;
      const db = b.loc ? CS.distM(geo.pos.lat, geo.pos.lng, b.loc.lat, b.loc.lng) : 1e9;
      return da - db;
    });
  } else {
    items.sort((a, b) => {
      const sa = (a.pBest || {}).section || '~', sb = (b.pBest || {}).section || '~';
      if (sa !== sb) {
        const oa = OAKGROVE_SECTION_ORDER.indexOf(sa), ob = OAKGROVE_SECTION_ORDER.indexOf(sb);
        if (oa !== -1 || ob !== -1) return (oa === -1 ? 99 : oa) - (ob === -1 ? 99 : ob);
        return sa.localeCompare(sb, undefined, { numeric: true });
      }
      const ba = blockOf(a), bb = blockOf(b);
      if (ba !== bb) return ba.localeCompare(bb, undefined, { numeric: true });
      return lotOf(a) - lotOf(b);
    });
  }
  return items;
}

function filteredRequests(model, filter, hideDone) {
  let items = model.requests.slice();
  if (filter) {
    const terms = filter.split(' ');
    items = items.filter(r => {
      const hay = normFilter(r.name + ' ' + r.plot + ' ' + (r.pRos ? r.pRos.section + ' ' + r.pRos.block + ' ' + r.pRos.lot : ''));
      return terms.every(t => hay.includes(t));
    });
  }
  if (hideDone) items = items.filter(r => !['done', 'nostone', 'notfound'].includes(progressOf(r.mid).st || ''));
  return items;
}

function sectionGroupsFor(model, items) {
  const groups = new Map();
  for (const r of items) {
    let key = 'No plot on record';
    if (r.pBest && r.pBest.section) {
      key = r.pBest.section === '*' ? 'Rows & lots (no section names here)'
        : (r.pBest.section + (r.pBest.section === 'Old Part' && r.pBest.sub ? ' — Sub ' + r.pBest.sub : ''));
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

/* nearest-cemetery banner: miles in the selector are from HOME; when GPS is on,
   tell the user which cemetery they're actually standing at */
let lastNearestCheck = 0;
function updateNearestBanner() {
  const el = $('nearest-banner');
  if (!geo.pos) { el.style.display = 'none'; return; }
  let best = null, bestD = Infinity;
  for (const c of DS.cemeteries) {
    const d = CS.distM(geo.pos.lat, geo.pos.lng, c.data.meta.cem.lat, c.data.meta.cem.lng);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || bestD > 1200 || activeCem() === String(best.id)) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `📍 You're at <strong>${esc(best.name)}</strong> (${fmtDist(bestD)}) — <a href="#" id="nearest-switch">switch to it</a>`;
  $('nearest-switch').onclick = ev => {
    ev.preventDefault();
    store.prefs.activeCem = String(best.id);
    save();
    renderCemSelect();
    renderWalk();
  };
}

let walkRenderToken = 0;
let walkMode = 'open'; // 'open' | 'finished'
const expandedCems = new Set(); // cemeteries expanded in 'All nearby' view

function renderFinished() {
  const wrap = $('walk-list');
  wrap.innerHTML = '';
  const rows = [];
  const openMids = new Set();
  for (const c of DS.cemeteries) {
    const model = getModel(c.id);
    if (!model) continue;
    for (const r of model.requests) {
      openMids.add(String(r.mid));
      const p = progressOf(r.mid);
      if (['done', 'nostone', 'notfound'].includes(p.st || '')) rows.push({ r, model, p, fulfilled: false });
    }
  }
  // finished work whose request has VANISHED from FAG's open list — the
  // refresher re-pulls requests every few hours, so a disappeared request
  // usually means the upload went through and the family got their photo
  for (const [pk, p] of Object.entries(store.progress)) {
    if (!['done', 'nostone', 'notfound'].includes(p.st || '')) continue;
    if (!/^\d+$/.test(pk) || openMids.has(pk)) continue;
    for (const c of DS.cemeteries) {
      const model = getModel(c.id);
      const mem = model && model.memById.get(+pk);
      if (mem) { rows.push({ r: { name: mem.name, mid: mem.mid, by: mem.by, dy: mem.dy }, model, p, fulfilled: true }); break; }
    }
  }
  rows.sort((a, b) => (b.p.ts || 0) - (a.p.ts || 0));
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="ornament">❧</div>Nothing finished yet — outcomes you mark will collect here for fulfilling on Find a Grave.</div>';
    return;
  }
  // pipeline counts: photographing is half the mission — the upload is the payoff
  const toUpload = rows.filter(x => x.p.st === 'done' && !x.p.up && !x.fulfilled).length;
  const uploaded = rows.filter(x => x.p.st === 'done' && x.p.up && !x.fulfilled).length;
  const confirmed = rows.filter(x => x.fulfilled).length;
  const head = document.createElement('div');
  head.className = 'small';
  head.style.cssText = 'padding:4px 2px 8px;';
  head.innerHTML = `<strong>${toUpload}</strong> to upload to Find a Grave · <strong>${uploaded}</strong> uploaded, awaiting FAG · <strong>${confirmed}</strong> confirmed fulfilled ✓`;
  wrap.appendChild(head);
  const stLabel = { done: '✓ Photographed', nostone: 'No stone found', notfound: 'Not found' };
  for (const { r, model, p, fulfilled } of rows) {
    const chip = fulfilled ? '<span class="badge stone">✓ no longer requested — fulfilled</span>'
      : p.st === 'done' ? (p.up ? '<span class="badge stone">⬆ uploaded</span>' : '<span class="badge rust">⏳ upload pending</span>')
      : '';
    const card = document.createElement('div');
    card.className = 'tcard st-' + p.st;
    card.innerHTML = `
      <div class="tname">${esc(r.name)}<span class="years">${CS.yearsOf(r)}</span> ${chip}</div>
      <div class="tmeta"><span class="lbl">${esc(model.cem.name)}</span> ${stLabel[p.st]}${p.ts ? ' · ' + new Date(p.ts).toLocaleDateString() : ''}${p.photo ? ' · 📷 photo attached' : ''}</div>
      ${p.note ? `<div class="reqnote">${esc(p.note)}</div>` : ''}
      ${p.gps ? `<div class="tmeta">📍 ${p.gps.lat}, ${p.gps.lng} (${fmtAcc(p.gps.acc)}) <button class="mini act-copy">Copy GPS</button></div>` : ''}
      <div class="trow-actions">
        <a class="mini" style="text-decoration:none;" href="https://www.findagrave.com/memorial/${r.mid}" target="_blank" rel="noopener">Open on Find a Grave ↗</a>
        ${p.st === 'done' && !fulfilled ? `<button class="mini act-up">${p.up ? '↩ not uploaded' : '⬆ Mark uploaded'}</button>` : ''}
        <button class="mini act-reopen">↩ Reopen</button>
      </div>`;
    const cp = card.querySelector('.act-copy');
    if (cp) cp.addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(p.gps.lat + ', ' + p.gps.lng)
        .then(() => toast('GPS copied — paste into the memorial\'s location on Find a Grave'), () => toast('Copy failed'));
    });
    const up = card.querySelector('.act-up');
    if (up) up.addEventListener('click', () => {
      setProgress(String(r.mid), { up: p.up ? 0 : Date.now(), st: 'done' });
      renderWalk();
    });
    card.querySelector('.act-reopen').addEventListener('click', () => {
      setProgress(String(r.mid), { st: '' });
      renderWalk();
      toast(r.name + ' reopened');
    });
    wrap.appendChild(card);
  }
}

/* ---------------- photo upload queue tab ---------------- */
function personByPk(pk) {
  pk = String(pk).split('#')[0];   // photo slot suffix isn't part of identity
  if (pk.startsWith('ros:')) {
    const key = pk.slice(4);
    for (const c of DS.cemeteries) {
      const m = getModel(c.id);
      const r = m && m.roster.find(x => String(x.key) === key);
      if (r) return {
        name: r.name, years: CS.yearsOf(r), model: m, mid: r.mem ? r.mem.mid : null,
        plot: [r.section !== '*' && r.section, r.block && 'Blk ' + r.block, r.lot && 'Lot ' + r.lot, r.grave && 'Gr ' + r.grave].filter(Boolean).join(' '),
      };
    }
  } else {
    for (const c of DS.cemeteries) {
      const m = getModel(c.id);
      const mem = m && m.memById.get(+pk);
      if (mem) return { name: mem.name, years: CS.yearsOf(mem), model: m, mid: mem.mid, plot: mem.plot };
    }
  }
  return null;
}
let queueInit = false;
async function renderQueue() {
  ensureAllModels();
  const list = $('queue-list'), summary = $('queue-summary');
  if (!queueInit) {
    queueInit = true;
    const d = new Date(); const to = d.toISOString().slice(0, 10);
    d.setDate(d.getDate() - 30); const from = d.toISOString().slice(0, 10);
    $('queue-from').value = from; $('queue-to').value = to;
    for (const id of ['queue-from', 'queue-to', 'queue-hideup'])
      $(id).addEventListener('change', renderQueue);
  }
  // photos on the Pi + photos still waiting on this phone
  const items = new Map();
  try {
    for (const p of ((await (await fetch('./api/photos')).json()).photos || [])) {
      const key = p.slot ? p.pk + '#' + p.slot : p.pk;
      items.set(key, { pk: key, ts: p.ts, size: p.size, synced: true });
    }
  } catch (e) { /* offline — local-only view */ }
  try {
    for (const pk of await photoDB.keys()) {
      const rec = await photoDB.get(pk);
      if (rec && !rec.synced) items.set(pk, { pk, ts: rec.ts, size: rec.blob ? rec.blob.size : 0, synced: false, rec });
    }
  } catch (e) { }
  const from = new Date($('queue-from').value + 'T00:00:00').getTime() || 0;
  const to = (new Date($('queue-to').value + 'T00:00:00').getTime() || 8.64e15) + 86400000;
  const hideUp = $('queue-hideup').checked;
  const basePk = k => String(k).split('#')[0];   // uploaded state is per grave
  const rows = [...items.values()]
    .filter(x => x.ts >= from && x.ts < to)
    .filter(x => !hideUp || !progressOf(basePk(x.pk)).up)
    .sort((a, b) => b.ts - a.ts);
  const totalMB = rows.reduce((s, x) => s + (x.size || 0), 0) / 1048576;
  const nUp = [...items.values()].filter(x => progressOf(basePk(x.pk)).up).length;
  summary.textContent = `${rows.length} photo${rows.length === 1 ? '' : 's'} in range (${totalMB.toFixed(1)} MB) · ${nUp} marked uploaded overall`;
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state"><div class="ornament">❧</div>No photos in this date range — field photos you attach on the guide land here.</div>';
    return;
  }
  for (const x of rows) {
    const who = personByPk(x.pk);
    const bpk = basePk(x.pk);
    const p = progressOf(bpk);
    const shot = x.pk.includes('#') ? ' · photo ' + (+x.pk.split('#')[1] + 1) : '';
    const name = who ? who.name : 'Unknown (' + bpk + ')';
    const fname = (name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'grave')
      + '_' + x.pk.replace(':', '-').replace('#', '-') + '.jpg';
    const card = document.createElement('div');
    card.className = 'tcard' + (p.up ? ' st-done' : '');
    const thumbSrc = x.synced
      ? './api/photo/' + encodeURIComponent(x.pk) + '?thumb=1&t=' + x.ts
      : (x.rec && (x.rec.thumb || x.rec.blob) ? URL.createObjectURL(x.rec.thumb || x.rec.blob) : '');
    card.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-start;">
        <img src="${thumbSrc}" style="width:92px; border-radius:4px; border:1px solid var(--line); flex:none;" alt="stone photo" loading="lazy">
        <div style="min-width:0;">
          <div class="tname">${esc(name)}<span class="years">${who ? esc(who.years) : ''}</span>
            ${p.up ? '<span class="badge stone">⬆ uploaded</span>' : '<span class="badge rust">⏳ to upload</span>'}
            ${x.synced ? '' : '<span class="badge">⌛ syncing from phone</span>'}
          </div>
          <div class="tmeta">${who ? `<span class="lbl">${esc(who.model.cem.name)}</span> ` : ''}${who && who.plot ? esc(who.plot) + ' · ' : ''}${new Date(x.ts).toLocaleDateString()}${x.size ? ' · ' + (x.size / 1048576).toFixed(1) + ' MB' : ''}${shot}</div>
          <div class="trow-actions" style="margin-top:5px;">
            ${x.synced ? `<a class="mini" style="text-decoration:none;" href="./api/photo/${encodeURIComponent(x.pk)}" download="${fname}">⬇ Download full-res</a>` : ''}
            ${who && who.mid ? `<a class="mini" style="text-decoration:none;" href="https://www.findagrave.com/memorial/${who.mid}" target="_blank" rel="noopener">Find a Grave ↗</a>` : ''}
            <button class="mini act-qup">${p.up ? '↩ not uploaded' : '⬆ Mark uploaded'}</button>
          </div>
        </div>
      </div>`;
    card.querySelector('.act-qup').addEventListener('click', () => {
      setProgress(bpk, { up: p.up ? 0 : Date.now(), st: progressOf(bpk).st || 'done' });
      renderQueue();
    });
    list.appendChild(card);
  }
}

function renderWalk() {
  updateNearestBanner();
  if (walkMode === 'finished') { renderFinished(); updateStats(); return; }
  const wrap = $('walk-list');
  const filter = normFilter($('walk-filter').value);
  const sort = $('walk-sort').value;
  const hideDone = $('walk-hidedone').checked;
  const token = ++walkRenderToken;
  wrap.innerHTML = '';

  const cems = activeCemList()
    .map(id => cemById.get(id))
    .sort((a, b) => (a.miles || 0) - (b.miles || 0));

  let any = false;
  const renderCem = idx => {
    if (token !== walkRenderToken) return; // superseded render
    if (idx >= cems.length) {
      if (!any) {
        const msg = !DS.cemeteries.length ? 'No dataset loaded. See the Data tab.'
          : filter ? `Nothing matches “${esc($('walk-filter').value.trim())}”.`
          : 'All caught up here ✓ — uncheck “hide finished” to review your work.';
        wrap.innerHTML = `<div class="empty-state"><div class="ornament">❧</div>${msg}</div>`;
      }
      updateStats();
      return;
    }
    const cem = cems[idx];
    const model = getModel(cem.id);
    if (model) {
      let items = sortRequests(filteredRequests(model, filter, hideDone), sort);
      if (items.length) {
        any = true;
        if (activeCem() === 'all') {
          const cid = String(cem.id);
          const expanded = expandedCems.has(cid) || !!filter; // searching expands everything
          const cc = model.meta.cem;
          const head = document.createElement('div');
          head.className = 'section-header';
          head.style.background = 'var(--ink)';
          head.style.cursor = 'pointer';
          head.innerHTML = `<h2>${esc(cem.name)}</h2>
            <a href="https://maps.google.com/?daddr=${cc.lat},${cc.lng}" target="_blank" rel="noopener" title="Drive there" style="color:var(--bg-deep); text-decoration:none; font-size:0.95rem;">🚗</a>
            <span class="meta">${cem.miles != null ? cem.miles + ' mi · ' : ''}${items.length} open ${expanded ? '▾' : '▸'}</span>`;
          head.addEventListener('click', ev => {
            if (ev.target.tagName === 'A') return; // let the drive link work
            expandedCems.has(cid) ? expandedCems.delete(cid) : expandedCems.add(cid);
            renderWalk();
          });
          wrap.appendChild(head);
          const shown = expanded ? items : items.slice(0, 4);
          for (const r of shown) wrap.appendChild(requestCard(r, model));
          if (!expanded && items.length > shown.length) {
            const more = document.createElement('button');
            more.className = 'mini';
            more.style.cssText = 'width:100%; padding:11px; border-top:none;';
            more.textContent = `Show all ${items.length} at ${cem.name} ▾`;
            more.addEventListener('click', () => { expandedCems.add(cid); renderWalk(); });
            wrap.appendChild(more);
          }
        } else if (sort === 'route') {
          for (const [name, list] of sectionGroupsFor(model, items)) {
            const div = document.createElement('div');
            div.className = 'section-group';
            const doneCount = list.filter(r => ['done', 'nostone', 'notfound'].includes(progressOf(r.mid).st || '')).length;
            div.innerHTML = `<div class="section-header"><h2>${esc(name)}</h2><span class="meta">${list.length - doneCount} open · ${list.length} total</span></div>`;
            for (const r of list) div.appendChild(requestCard(r, model));
            wrap.appendChild(div);
          }
        } else {
          for (const r of items) wrap.appendChild(requestCard(r, model));
        }
      }
    }
    setTimeout(() => renderCem(idx + 1), 0); // progressive render, nearest first
  };
  renderCem(0);
}

function requestCard(req, model) {
  const card = document.createElement('div');
  const st = progressOf(req.mid).st || '';
  card.className = 'tcard' + (st ? ' st-' + st : '');
  const yrs = CS.yearsOf(req);
  const distTxt = (geo.pos && req.loc) ? fmtDist(CS.distM(geo.pos.lat, geo.pos.lng, req.loc.lat, req.loc.lng)) + ' away' : '';
  const prog = progressOf(req.mid);
  const reqYear = (String(req.created).match(/\b(20\d\d)\b/) || [])[1];
  const ageDays = reqYear ? (Date.now() - new Date(req.created).getTime()) / 86400000 : 0;
  const eraHint = (!req.loc && req.dy) ? CS.suggestSection(model, req.dy) : null;
  card.innerHTML = `
    <div class="tname">${esc(req.name)}${yrs ? `<span class="years">${yrs}</span>` : ''}
      ${req.mem && req.mem.veteran ? '<span class="badge stone" title="veteran">vet</span>' : ''}
      ${req.plotConflict ? '<span class="badge rust" title="Find a Grave and city register disagree — verify">verify plot</span>' : ''}
      ${req.rosVerify ? '<span class="badge outline" title="register row matched by name/date similarity — double-check it is the same person">register match — verify</span>' : ''}
      ${ageDays > 550 ? `<span class="badge gold" title="long-open request — others have likely tried; lean on family leads and the register">⏳ since ${reqYear}</span>` : ''}
      ${req.claimed ? '<span class="badge outline" title="another volunteer has claimed this request on Find a Grave — coordinate before shooting">claimed</span>' : ''}
    </div>
    <div class="tmeta">${plotLine(req) || '<span class="lbl">plot</span>—'}</div>
    <div>${locChip(req, model)}${eraHint ? ` <span class="mono small">· ${req.dy}-era burials cluster in ${esc(eraHint.section)}</span>` : ''}${distTxt ? ` <span class="mono small">· ${distTxt}</span>` : ''}${prog.note ? ' <span title="has field note">📝</span>' : ''}</div>
    ${req.problem ? `<div class="reqnote" style="border-left-color:var(--rust);">⚠ previously reported: “${esc(req.problem)}”</div>` : ''}
    ${prog.gps ? `<div class="tmeta">📍 saved ${prog.gps.lat}, ${prog.gps.lng} (${fmtAcc(prog.gps.acc)})</div>` : ''}
    ${req.notes ? `<div class="reqnote">“${esc(String(req.notes).replace(/<br\s*\/?>/gi, ' '))}” <span class="small">— requester${req.req ? ', ' + esc(req.req) : ''}</span></div>` : ''}
    <div class="trow-actions">
      <button class="mini act-guide">➤ Guide</button>
      <button class="mini act-nb">Neighbors</button>
      <a class="mini" style="text-decoration:none;" href="https://www.findagrave.com/memorial/${req.mid}" target="_blank" rel="noopener">Find a Grave ↗</a>
      <button class="mini act-done ${st === 'done' ? 'on' : ''}">✓ Done</button>
      <button class="mini act-nostone ${st === 'nostone' ? 'on' : ''}">No stone</button>
      <button class="mini act-notfound ${st === 'notfound' ? 'on' : ''}">Not found</button>
    </div>
    <div class="neighbors"></div>`;
  card.querySelector('.act-guide').addEventListener('click', () => openGuide(req, model));
  card.querySelector('.act-nb').addEventListener('click', () => {
    const nb = card.querySelector('.neighbors');
    if (!nb.dataset.loaded) { nb.innerHTML = neighborsHtml(req, model); nb.dataset.loaded = '1'; wireLeadButtons(nb, model); }
    nb.classList.toggle('open');
  });
  // state changes update THIS card in place — never a full re-render that would
  // lose the user's scroll position mid-cemetery
  const ST_LABEL = { done: 'Photographed ✓', nostone: 'No stone found', notfound: 'Not found' };
  const setSt = v => () => {
    const cur = progressOf(req.mid).st;
    const next = cur === v ? '' : v;
    setProgress(req.mid, { st: next });
    card.className = 'tcard' + (next ? ' st-' + next : '');
    for (const [k, cls] of [['done', '.act-done'], ['nostone', '.act-nostone'], ['notfound', '.act-notfound']]) {
      card.querySelector(cls).classList.toggle('on', next === k);
    }
    toast(next ? `${req.name}: ${ST_LABEL[next]} — tap again to undo` : `${req.name}: reopened`);
    if (next && $('walk-hidedone').checked) {
      card.style.transition = 'opacity 0.6s';
      card.style.opacity = '0.25';
      setTimeout(() => { if (progressOf(req.mid).st === next) card.remove(); }, 1500);
    }
  };
  card.querySelector('.act-done').addEventListener('click', setSt('done'));
  card.querySelector('.act-nostone').addEventListener('click', setSt('nostone'));
  card.querySelector('.act-notfound').addEventListener('click', setSt('notfound'));
  return card;
}

// family leads / neighbors with a location get their own ➤ button
function wireLeadButtons(container, model) {
  for (const btn of container.querySelectorAll('.act-lead')) {
    btn.addEventListener('click', () => {
      const d = btn.dataset;
      openGuide({
        name: d.name, mid: +d.mid || null, ln: d.ln || '',
        loc: { lat: +d.lat, lng: +d.lng, acc: +d.acc, level: d.level },
        pBest: null, plot: d.plot || '',
      }, model);
    });
  }
}

function familyHtml(req, model) {
  const fam = CS.familyHints(model, req, 8);
  let html = '';
  if (!fam.length) {
    html = '<div class="small">No plot info and no promising same-surname burials here.</div>';
  } else {
    const hasTrue = fam.some(f => f.isFamily);
    html = hasTrue
      ? '<h4>Family on record (from Find a Grave\'s own links — strongest lead):</h4>'
      : '<h4>No plot on record — family leads (spouses usually share the lot):</h4>';
    for (const f of fam) {
      const lead = f.loc
        ? `<button class="mini act-lead" data-name="${esc(f.name)}" data-mid="${f.mid}" data-lat="${f.loc.lat}" data-lng="${f.loc.lng}" data-acc="${Math.round(f.loc.acc)}" data-level="${f.loc.level}" data-plot="${esc(f.plot)}">➤ Guide</button>`
        : '';
      html += `<div class="nb">
        ${f.isFamily ? '<span title="linked as spouse/child on Find a Grave">👪</span>' : ''}
        ${f.hasPhoto ? '<span class="cam">📷</span>' : '<span class="cam" style="opacity:0.25;">·</span>'}
        <a href="https://www.findagrave.com/memorial/${f.mid}" target="_blank" rel="noopener">${esc(f.name)}</a>
        <span class="g">${esc(f.years)}${f.plot ? ' · ' + esc(f.plot) : ''}${f.loc ? ' · ' + levelLabel(f.loc.level) + ' ' + fmtAcc(f.loc.acc) : ''}</span>
        ${lead}
      </div>`;
    }
  }
  // wrong-cemetery check: the same person may be recorded at another local cemetery
  if (!req.loc && (req.dy || req.by)) {
    const xc = CS.crossCemeteryMatches(builtModels(), req, model);
    if (xc.length) {
      html += '<h4 style="margin-top:8px;">⚠ Same name & dates found at another cemetery — the request may be misplaced:</h4>';
      for (const x of xc) {
        html += `<div class="nb">
          <span>${esc(x.model.cem.name)}:</span>
          ${x.kind === 'mem'
            ? `<a href="https://www.findagrave.com/memorial/${x.item.mid}" target="_blank" rel="noopener">${esc(x.item.name)}</a>`
            : esc(x.item.name) + ' <span class="g">(register)</span>'}
          <span class="g">${esc(CS.yearsOf(x.item))}</span>
        </div>`;
      }
    }
  }
  // still stuck? research links that resolve most "tried and failed" cases
  const links = CS.researchLinks(req).map(l => `<a class="mini" style="text-decoration:none;" href="${l.url}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`);
  html += `<div class="trow-actions" style="margin-top:8px;">${links.join(' ')}</div>`;
  const contact = model && model.cem && model.cem.contact;
  if (contact) html += `<div class="small" style="margin-top:6px;">📞 Burial records: ${esc(contact)}</div>`;
  return html;
}
function neighborsHtml(req, model) {
  const p = req.pBest;
  if (!p || !p.section) return familyHtml(req, model);
  const nbs = CS.neighbors(model, p, req.mid);
  if (!nbs.length) return familyHtml(req, model);
  // keep the shown subset honest: nearest first, but photographed anchors always survive the cut
  const CAP = 14;
  let shown;
  if (nbs.length <= CAP) shown = nbs;
  else {
    const pick = new Set(nbs.filter(n => n.hasPhoto).slice(0, 5));
    for (const n of nbs) { if (pick.size >= CAP) break; pick.add(n); }
    shown = nbs.filter(n => pick.has(n));
  }
  const photoShown = shown.filter(n => n.hasPhoto).length;
  let html = `<h4>Buried nearby — showing ${shown.length} of ${nbs.length}, ${photoShown} with photographed stones (📷 = visual anchor)</h4>`;
  for (const n of shown) {
    html += `<div class="nb">
      ${n.hasPhoto ? '<span class="cam">📷</span>' : '<span class="cam" style="opacity:0.25;">·</span>'}
      ${n.mid ? `<a href="https://www.findagrave.com/memorial/${n.mid}" target="_blank" rel="noopener">${esc(n.name)}</a>` : esc(n.name)}
      <span class="g">${esc(n.years)} · ${esc(n.rel || 'nearby')}${n.grave ? ' · grave ' + esc(n.grave) : ''}${n.fromRegister ? ' · register' : ''}</span>
    </div>`;
  }
  return html;
}

/* ---------------- guide overlay ---------------- */
let guideTarget = null;
let guideModel = null;
let guideMap = null;
let arrowRAF = null;
let lastGuideDom = { dist: null, sub: null };
let lastMiniDraw = { lat: null, lng: null };

function openGuide(target, model) {
  guideTarget = target;
  guideModel = model || null;
  target.pk = target.mid ? String(target.mid) : (target.rosKey ? 'ros:' + target.rosKey : null);
  compass.declination = (model && model.meta.declination != null) ? model.meta.declination : -6.6;
  $('guide-name').textContent = target.name;
  // vitals: everything known about the person, from every source — dates on
  // the stone are what you match against when you're standing in the row
  const mem = (target.mid && model) ? model.memById.get(target.mid) : null;
  const ros = (target.rosKey && model) ? model.roster.find(r => String(r.key) === String(target.rosKey))
    : (mem && mem.ros) || target.ros || null;
  const vit = [];
  const bd = (ros && ros.bd) || target.bd || '';
  const dd = (ros && ros.dd) || target.dd || '';
  const by = target.by || (mem && mem.by) || (ros && ros.by) || 0;
  const dy = target.dy || (mem && mem.dy) || (ros && ros.dy) || 0;
  if (bd || dd) vit.push([bd && 'b. ' + bd, dd && 'd. ' + dd].filter(Boolean).join('   '));
  else if (by || dy) vit.push((by || '?') + ' – ' + (dy || '?'));
  if (by && dy && dy >= by) vit.push('age ' + ((bd && dd) ? (dy - by) : '~' + (dy - by)));
  if (ros && ros.burial && ros.burial !== dd) vit.push('buried ' + ros.burial);
  const maiden = (mem && mem.maiden) || (ros && ros.formerName) || '';
  if (maiden) vit.push('née ' + maiden);
  if ((mem && mem.veteran) || (ros && ros.veteran) || target.veteran) vit.push('⚑ veteran');
  if (mem && mem.hasGravePhoto) vit.push('📷 stone photographed — the photo on Find a Grave shows what to look for');
  $('guide-vitals').textContent = vit.join('  ·  ');
  // requester hints and register notes often carry the clue that finds it
  const hints = [];
  if (target.notes) hints.push('💬 requester: ' + target.notes);
  if (target.problem) hints.push('⚠ previously reported: ' + target.problem);
  if (ros && ros.note && !/^sexton record/.test(ros.note)) hints.push('📖 register: ' + ros.note);
  $('guide-hints').textContent = hints.join('   ');
  const plotBits = [];
  if (model && model.cem) plotBits.push(model.cem.name);
  if (target.plot && !/no location/i.test(target.plot)) plotBits.push(target.plot);
  if (target.pRos) {
    const regTxt = [target.pRos.section === '*' ? '' : target.pRos.section + (target.pRos.sub ? ' Sub ' + target.pRos.sub : ''), target.pRos.block && 'Blk ' + target.pRos.block, target.pRos.lot && 'Lot ' + target.pRos.lot, target.pRos.grave && 'Gr ' + target.pRos.grave].filter(Boolean).join(' ');
    // don't repeat an identical plot twice when both sources agree
    if (regTxt && !plotBits.some(b => normFilter(b) === normFilter(regTxt))) plotBits.push('Register: ' + regTxt);
  }
  if (target.loc) plotBits.push(fmtAcc(target.loc.acc) + ' (' + levelLabel(target.loc.level) +
    (target.loc.level === 'family' && target.loc.via ? ' — ' + target.loc.via + "'s grave; spouses usually share the lot" : '') + ')');
  const savedGps = target.pk && progressOf(target.pk).gps;
  if (savedGps) plotBits.push('📍 saved ' + savedGps.lat + ', ' + savedGps.lng);
  $('guide-plot').textContent = plotBits.join('  ·  ') || 'no location information';
  $('guide-fag').href = target.mid ? 'https://www.findagrave.com/memorial/' + target.mid : '#';
  $('guide-fag').style.display = target.mid ? '' : 'none';
  $('guide-note').value = (target.pk && progressOf(target.pk).note) || '';
  // always show something useful below: neighbors when there's a plot, family leads otherwise
  $('guide-neighbors').innerHTML = model ? neighborsHtml(target, model) : '';
  if (model) wireLeadButtons($('guide-neighbors'), model);
  syncGuideButtons();
  renderGuidePhoto();

  $('guide').classList.add('open');
  document.body.style.overflow = 'hidden';

  geo.on();
  compass.enable();
  wakeOn();

  if (!guideMap) guideMap = new MapView($('guide-minimap'), gproj, { imagery: imageryPref() });
  guideMap.layers = buildLayers(model ? [String(model.cem.id)] : activeCemList(), target);
  guideMap.highlight = target.loc ? { lat: target.loc.lat, lng: target.loc.lng, acc: target.loc.acc } : null;
  guideMap.resize();
  if (target.loc) guideMap.centerOn(target.loc.lat, target.loc.lng, 4.5);
  else if (model) guideMap.centerOn(model.meta.cem.lat, model.meta.cem.lng, 1.2);

  lastGuideDom = { dist: null, sub: null };
  lastMiniDraw = { lat: null, lng: null };
  cancelAnimationFrame(arrowRAF);
  const loop = () => { drawArrow(); arrowRAF = requestAnimationFrame(loop); };
  loop();
}
function closeGuide() {
  $('guide').classList.remove('open');
  document.body.style.overflow = '';
  cancelAnimationFrame(arrowRAF);
  wakeOff();
  renderWalk();
}
$('guide-close').addEventListener('click', closeGuide);

function syncGuideButtons() {
  const p = guideTarget && guideTarget.pk ? progressOf(guideTarget.pk) : {};
  const st = p.st || '';
  const set = (id, active, label, cls) => {
    const b = $(id);
    b.textContent = label;
    b.classList.toggle('marked', active);
    b.classList.toggle(cls, active);
  };
  set('guide-done', st === 'done', st === 'done' ? '✔ PHOTOGRAPHED' : '✓ Photographed', 'm-done');
  set('guide-nostone', st === 'nostone', st === 'nostone' ? '✔ NO STONE' : 'No stone found', 'm-nostone');
  set('guide-notfound', st === 'notfound', st === 'notfound' ? '✔ NOT FOUND' : 'Not found', 'm-notfound');
  // plain-language status banner: the outcome in words, with when it was set
  const banner = $('guide-state');
  const words = {
    done: '✔ Marked photographed',
    nostone: '✔ Marked: no stone found',
    notfound: '✔ Marked: not found',
  }[st];
  banner.className = 'guide-state' + (st ? ' show s-' + st : '');
  banner.textContent = words
    ? words + (p.ts ? ' · ' + new Date(p.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
      + (st === 'done' && !p.up ? ' · still to upload' : st === 'done' && p.up ? ' · uploaded ✓' : '')
    : '';
  // second stage of the pipeline: field photo taken -> uploaded to FAG at home
  const upBtn = $('guide-uploaded');
  upBtn.style.display = st === 'done' ? '' : 'none';
  upBtn.textContent = p.up ? '✔ Uploaded to FAG' : '⬆ Uploaded to FAG';
  upBtn.classList.toggle('on', !!p.up);
}
$('guide-uploaded').addEventListener('click', () => {
  if (!guideTarget || !guideTarget.pk) return;
  const was = progressOf(guideTarget.pk).up;
  setProgress(guideTarget.pk, { up: was ? 0 : Date.now(), st: 'done' });
  syncGuideButtons();
  toast(was ? 'Marked not uploaded yet' : 'Marked uploaded to Find a Grave ✓');
});
/* field photos for THIS grave — several per grave (stone, context, detail);
   storage keys are "<pk>" for the first and "<pk>#<n>" for the rest */
const photoKey = (pk, slot) => (slot ? pk + '#' + slot : pk);
async function photoSlotsFor(pk) {
  const out = [];
  const localKeys = await photoDB.keys().catch(() => []);
  for (let slot = 0; slot < 12; slot++) {
    const key = photoKey(pk, slot);
    if (localKeys.includes(key)) {
      const rec = await photoDB.get(key);
      if (rec && (rec.thumb || rec.blob)) out.push({ slot, key, rec });
    }
  }
  return out;
}
async function renderGuidePhoto() {
  const row = $('guide-photo-row');
  if (!guideTarget || !guideTarget.pk) { row.style.display = 'none'; return; }
  const pk = guideTarget.pk;
  const local = await photoSlotsFor(pk);
  const localSlots = new Set(local.map(l => l.slot));
  // ask the Pi what it actually holds for this grave rather than trusting a
  // per-device count — that's how a second phone's shots show up here too
  const serverSlots = [];
  try {
    const list = (await (await fetch('./api/photos')).json()).photos || [];
    for (const p of list) if (p.pk === pk && !localSlots.has(p.slot)) serverSlots.push(p.slot);
  } catch (e) {
    const prog = progressOf(pk);   // offline: fall back to the local count
    for (let slot = 0; slot < (prog.photo || 0); slot++) if (!localSlots.has(slot)) serverSlots.push(slot);
  }
  if (!local.length && !serverSlots.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.innerHTML = '';
  const add = (src, label, key) => {
    const d = document.createElement('div');
    d.className = 'photo-thumb';
    d.innerHTML = `<img src="${src}" alt="grave photo"><div class="st">${label}</div><div class="badge-x" title="remove">✕</div>`;
    d.querySelector('.badge-x').addEventListener('click', async () => {
      if (!confirm('Remove this photo?')) return;
      await photoDB.del(key).catch(() => {});
      fetch('./api/photo/' + encodeURIComponent(key), { method: 'DELETE' }).catch(() => {});
      const n = (progressOf(pk).photo || 1) - 1;
      setProgress(pk, { photo: n > 0 ? n : 0 });
      renderGuidePhoto();
    });
    row.appendChild(d);
  };
  for (const l of local) add(URL.createObjectURL(l.rec.thumb || l.rec.blob), l.rec.synced ? '☁ on Pi' : '⌛ queued', l.key);
  for (const slot of serverSlots) {
    const key = photoKey(pk, slot);
    add('./api/photo/' + encodeURIComponent(key) + '?thumb=1&t=' + Date.now(), '☁ on Pi', key);
  }
  row.style.display = 'flex';
}
$('guide-photo').addEventListener('click', () => $('guide-photo-input').click());
$('guide-photo-input').addEventListener('change', async () => {
  const files = [...$('guide-photo-input').files];
  $('guide-photo-input').value = '';
  if (!files.length || !guideTarget || !guideTarget.pk) return;
  const pk = guideTarget.pk;
  let slot = (progressOf(pk).photo || 0);
  let added = 0, mb = 0;
  for (const f of files) {
    try {
      // full resolution queues for the Pi; a small thumb renders lists fast
      const blob = await ensureJpeg(f);
      const thumb = await shrinkPhoto(f, 480, 0.75);
      await photoDB.put(photoKey(pk, slot), { blob, thumb, ts: Date.now(), synced: false });
      slot++; added++; mb += blob.size / 1048576;
    } catch (e) { /* skip unreadable file */ }
  }
  if (!added) { toast('Could not read that photo'); return; }
  setProgress(pk, { photo: slot });          // count rides along in progress sync
  if (navigator.vibrate) navigator.vibrate(18);
  renderGuidePhoto();
  toast(`📷 ${added} photo${added > 1 ? 's' : ''} added to ${guideTarget.name} (${mb.toFixed(1)} MB) — syncing to the Pi, then the Queue tab`, 4000);
  syncPhotos();
});
function guideSetState(v, extraTip) {
  if (!guideTarget || !guideTarget.pk) return;
  const cur = progressOf(guideTarget.pk).st;
  const next = cur === v ? '' : v;
  setProgress(guideTarget.pk, { st: next });
  syncGuideButtons();
  const label = { done: 'Photographed ✓', nostone: 'No stone found', notfound: 'Not found' }[v];
  // three confirmations at once: the button pulses, the panel flashes the
  // outcome colour, and the phone buzzes — no doubt it registered
  const btn = { done: 'guide-done', nostone: 'guide-nostone', notfound: 'guide-notfound' }[v];
  if (btn) {
    const b = $(btn);
    b.classList.remove('justmarked');
    void b.offsetWidth;               // restart the animation
    b.classList.add('justmarked');
  }
  const panel = $('guide');
  panel.classList.remove('flash-done', 'flash-nostone', 'flash-notfound');
  if (next) {
    void panel.offsetWidth;
    panel.classList.add('flash-' + v);
    setTimeout(() => panel.classList.remove('flash-' + v), 600);
  }
  if (navigator.vibrate) navigator.vibrate(next ? [18, 40, 18] : 12);
  if (!next) toast('Reopened — no outcome set');
  else toast('✔ ' + label + (extraTip ? ' — ' + extraTip : ''), extraTip ? 4200 : 2600);
  // recolour this grave's pin on both maps straight away
  if (mainMap) refreshMapLayers();
  if (guideMap && guideModel) {
    guideMap.layers = buildLayers([String(guideModel.cem.id)], guideTarget);
    guideMap.draw();
  }
}
$('guide-done').addEventListener('click', () => guideSetState('done'));
$('guide-nostone').addEventListener('click', () => guideSetState('nostone', 'photograph the spot in context and flag the request on Find a Grave'));
$('guide-notfound').addEventListener('click', () => guideSetState('notfound'));
$('guide-savegps').addEventListener('click', () => {
  if (!geo.pos) { toast('No GPS fix yet'); return; }
  if (!guideTarget || !guideTarget.pk) return;
  const gps = { lat: +geo.pos.lat.toFixed(6), lng: +geo.pos.lng.toFixed(6), acc: Math.round(geo.pos.acc) };
  setProgress(guideTarget.pk, { gps });
  // the saved fix becomes an anchor: rebuild this cemetery's model so the
  // whole lot/block sharpens — and walk-order rows REFIT — right now, in
  // the field, with this pin included
  if (guideModel && guideModel.cem) {
    models.delete(String(guideModel.cem.id));
    if (mainMap) refreshMapLayers();
    if (guideMap && guideTarget) guideMap.layers = buildLayers([String(guideModel.cem.id)], guideTarget);
  }
  if (navigator.clipboard) navigator.clipboard.writeText(gps.lat + ', ' + gps.lng).catch(() => {});
  toast(`Saved & copied ${gps.lat}, ${gps.lng} (${fmtAcc(gps.acc)}) — this pin also sharpens the map for its whole lot`, 4200);
});
$('guide-note').addEventListener('input', () => {
  if (guideTarget && guideTarget.pk) setProgress(guideTarget.pk, { note: $('guide-note').value });
});

function drawArrow() {
  const cv = $('arrow-canvas');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;

  const t = guideTarget;
  let distTxt = '—', sub = '';
  let bearing = null;
  if (t && t.loc && geo.pos) {
    const d = CS.distM(geo.pos.lat, geo.pos.lng, t.loc.lat, t.loc.lng);
    const ft = d * M_TO_FT;
    distTxt = ft >= 1000 ? (d / 1609.344).toFixed(2) + '<span class="unit"> mi</span>' : Math.round(ft) + '<span class="unit"> ft</span>';
    bearing = CS.bearingDeg(geo.pos.lat, geo.pos.lng, t.loc.lat, t.loc.lng);
    const head = compass.best();
    if (head) sub = `bearing ${Math.round(bearing)}° · heading ${Math.round(head.h)}° (${head.src}) · GPS ${fmtAcc(geo.pos.acc)}`;
    else sub = `bearing ${Math.round(bearing)}° ${compassPoint(bearing)} · face north & follow · GPS ${fmtAcc(geo.pos.acc)}`;
    if (d <= Math.max(8, t.loc.acc)) sub = `you're within the search circle (${fmtAcc(t.loc.acc)}) — read the stones · ` + sub;
  } else if (!geo.pos) {
    if (geo.err && geo.err.code === 1) sub = 'location permission denied — allow it for this site in your browser settings';
    else if (typeof isSecureContext !== 'undefined' && !isSecureContext) sub = 'GPS needs the https:// address — open it and accept the certificate warning once';
    else sub = 'waiting for GPS fix… (clear sky helps)';
  } else if (t && !t.loc) {
    sub = 'no predicted location — see the leads below the map';
  }
  if (distTxt !== lastGuideDom.dist) { $('guide-dist').innerHTML = distTxt; lastGuideDom.dist = distTxt; }
  if (sub !== lastGuideDom.sub) { $('guide-sub').textContent = sub; lastGuideDom.sub = sub; }

  const head = compass.best();
  const rot = bearing == null ? null : ((bearing - (head ? head.h : 0)) * Math.PI / 180);

  // skip the canvas repaint when nothing moved — the RAF loop otherwise burns
  // battery redrawing an identical arrow during long wake-locked sessions
  const frameKey = (rot == null ? 'x' : rot.toFixed(2)) + '|' + (head ? head.h.toFixed(1) : '') + '|' + distTxt + '|' + sub;
  if (frameKey === lastGuideDom.frameKey) { updateGuideMinimap(); return; }
  lastGuideDom.frameKey = frameKey;
  ctx.clearRect(0, 0, W, H);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  ctx.arc(0, 0, 150, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(110,101,87,0.45)';
  ctx.lineWidth = 3;
  ctx.stroke();
  const northRot = head ? (-head.h * Math.PI / 180) : 0;
  ctx.save();
  ctx.rotate(northRot);
  ctx.fillStyle = 'rgba(139,58,31,0.8)';
  ctx.font = 'bold 26px JetBrains Mono, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -118);
  ctx.restore();
  if (rot != null) {
    ctx.rotate(rot);
    ctx.fillStyle = '#2c3a24';
    ctx.beginPath();
    ctx.moveTo(0, -104);
    ctx.lineTo(34, 48);
    ctx.lineTo(0, 22);
    ctx.lineTo(-34, 48);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(110,101,87,0.4)';
    ctx.font = '15px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(geo.pos ? '· no target ·' : '· no GPS ·', 0, 5);
  }
  ctx.restore();

  updateGuideMinimap();
}
function updateGuideMinimap() {
  if (guideMap && geo.pos && (geo.pos.lat !== lastMiniDraw.lat || geo.pos.lng !== lastMiniDraw.lng)) {
    lastMiniDraw = { lat: geo.pos.lat, lng: geo.pos.lng };
    guideMap.user = geo.pos;
    guideMap.draw();
  }
}
function compassPoint(b) {
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(b / 22.5) % 16];
}

/* ---------------- map layers ---------------- */
function modelLayerCache(model) {
  if (model._layerCache) return model._layerCache;
  const lots = [], blocks = [], roads = [], graves = [];
  // every GPS-tagged memorial at its true position — for well-photographed
  // cemeteries this is a full grave map with no plat needed
  const cc = model.cem && model.cem.data.meta.cem;
  const seenCoord = new Set();
  if (cc) {
    for (const m of model.memorials) {
      if (m.lat == null || m.lng == null) continue;
      const d = CS.distM(m.lat, m.lng, cc.lat, cc.lng);
      if (!isFinite(d) || d < 5 || d > 800) continue;   // default/junk pins
      const ck = m.lat.toFixed(6) + ',' + m.lng.toFixed(6);
      if (seenCoord.has(ck)) continue;                  // bulk-pinned families: one dot
      seenCoord.add(ck);
      // pin=true marks a field-confirmed position (you stood there) — drawn
      // as a blue diamond, the map's strongest statement
      graves.push({ lat: m.lat, lng: m.lng, label: m.last, ph: m.hasGravePhoto, mid: m.mid, model, pin: !!m.fieldGps });
    }
  }
  // register burials that locate confidently get dots too (hollow squares) —
  // often the very stones being searched for: people the register places
  // but no Find a Grave photo has pinned
  for (const r of model.roster) {
    if (r.mem && r.mem.lat != null) continue;   // already drawn via the memorial
    if (!r.section) continue;
    if (r.fieldGps) {   // field-confirmed register burial: diamond at the pin itself
      graves.push({ lat: r.fieldGps.lat, lng: r.fieldGps.lng, label: r.last, ph: false, reg: true, rosKey: r.key, model, pin: true });
      continue;
    }
    const loc = CS.locate(model, { section: r.section, sub: r.sub, block: r.block, lot: r.lot, grave: r.grave });
    if (!loc || (loc.level !== 'lot' && loc.level !== 'adjacent')) continue;
    graves.push({ lat: loc.lat, lng: loc.lng, label: r.last, ph: false, reg: true, rosKey: r.key, model });
  }
  for (const m of model.maps) {
    if (!m.transform) continue;
    for (const en of m.entries) {
      const w = CS.applyT(m.transform, en[2], en[3]);
      const ll = model.proj.toLL(w.e, w.n);
      if (!isFinite(ll.lat)) continue;
      // who is recorded in this lot? a lot with names behind it is worth
      // tapping; an empty one is just grid furniture
      const occ = CS.lotOccupants(model, m.section, m.sub, en[0], en[1]);
      lots.push({
        lat: ll.lat, lng: ll.lng, label: String(en[1]),
        n: occ.length, occ, model,
        section: m.section, sub: m.sub, block: en[0], lot: String(en[1]),
      });
    }
    for (const b of (m.blocks || [])) {
      const w = CS.applyT(m.transform, b.x, b.y);
      const ll = model.proj.toLL(w.e, w.n);
      blocks.push({ lat: ll.lat, lng: ll.lng, label: b.b });
    }
    for (const r of (m.roads || [])) {
      const w = CS.applyT(m.transform, r.x, r.y);
      const ll = model.proj.toLL(w.e, w.n);
      roads.push({ lat: ll.lat, lng: ll.lng });
    }
  }
  const sections = Object.entries(model.sections)
    .filter(([label]) => label !== '*')
    .map(([label, s]) => ({ lat: s.lat, lng: s.lng, label }));
  // cemetery grounds from OSM: boundary polygons, internal drives, gates
  const g = model.cem && model.cem.data.grounds;
  const bounds = (g && g.bounds || []).map(pts => ({ pts }));
  const drives = (g && g.drives || []).map(pts => ({ pts }));
  const gates = (g && g.gates || []).map(([lat, lng]) => ({ lat, lng }));
  model._layerCache = { lots, blocks, roads, sections, graves, bounds, drives, gates };
  return model._layerCache;
}

function buildLayers(cemIds, soloTarget) {
  const L = { lots: [], blocks: [], roads: [], sections: [], cems: [], targets: [], graves: [], bounds: [], drives: [], gates: [] };
  for (const cid of cemIds) {
    const model = getModel(cid);
    if (!model) continue;
    const cache = modelLayerCache(model);
    L.lots.push(...cache.lots);
    L.graves.push(...cache.graves);
    L.bounds.push(...cache.bounds);
    L.drives.push(...cache.drives);
    L.gates.push(...cache.gates);
    L.blocks.push(...cache.blocks);
    L.roads.push(...cache.roads);
    L.sections.push(...cache.sections);
    const cem = model.cem;
    L.cems.push({ lat: cem.data.meta.cem.lat, lng: cem.data.meta.cem.lng, label: cem.name });
    if (soloTarget) continue;
    for (const r of model.requests) {
      if (!r.loc) continue;
      const st = progressOf(r.mid).st || '';
      L.targets.push({
        lat: r.loc.lat, lng: r.loc.lng,
        color: st === 'done' ? '#2e7d32' : st ? '#a07a2c' : '#8b3a1f',
        label: r.ln, ref: r, model, r: 5.5,
        // an inferred position (a relative's lot, or a whole section) should
        // not look as certain as a drawn lot — draw it hollow so the map
        // never overstates what we know
        soft: r.loc.level === 'family' || r.loc.level === 'section',
      });
    }
  }
  if (soloTarget && soloTarget.loc) {
    L.targets.push({ lat: soloTarget.loc.lat, lng: soloTarget.loc.lng, color: '#8b3a1f', r: 7 });
  }
  return L;
}

/* tapping a lot number: who is recorded in this lot? */
function openLotSheet(lot) {
  const model = lot.model;
  const where = [lot.section === '*' ? '' : lot.section + (lot.sub ? ' Sub ' + lot.sub : ''),
    lot.block ? 'Blk ' + lot.block : '', 'Lot ' + lot.lot].filter(Boolean).join(' ');
  const rows = lot.occ.map(o => {
    const w = o.who;
    const isMem = w.kind === 'mem';
    const years = CS.yearsOf(w);
    const badges = [
      o.grave ? `<span class="badge">grave ${esc(o.grave)}</span>` : '',
      isMem && w.hasGravePhoto ? '<span title="stone photographed">📷</span>' : '',
      isMem && w.hasRequest ? '<span class="badge rust">photo requested</span>' : '',
      !isMem ? '<span class="badge stone">register</span>' : '',
      w.veteran ? '<span class="badge stone">vet</span>' : '',
    ].filter(Boolean).join(' ');
    return `<div class="nb" data-mid="${isMem ? w.mid : (w.mem ? w.mem.mid : '')}" data-ros="${isMem ? '' : w.key}">
      <a href="#" class="act-lot-guide">${esc(w.name)}</a>
      <span class="g">${esc(years)}</span> ${badges}
    </div>`;
  }).join('');
  const sheet = $('lot-sheet');
  sheet.innerHTML = `<div class="card" style="margin:0;">
      <div class="tname">${esc(model.cem.name)} · ${esc(where)}
        <button class="mini" id="lot-close" style="float:right;">✕</button></div>
      <div class="tmeta">${lot.occ.length} recorded here — tap a name to navigate</div>
      ${rows}
    </div>`;
  sheet.style.display = 'block';
  $('lot-close').addEventListener('click', () => { sheet.style.display = 'none'; });
  for (const el of sheet.querySelectorAll('.act-lot-guide')) {
    el.addEventListener('click', ev => {
      ev.preventDefault();
      const d = el.closest('.nb').dataset;
      const mem = d.mid ? model.memById.get(+d.mid) : null;
      const ros = d.ros ? model.roster.find(r => String(r.key) === d.ros) : null;
      const person = mem || ros;
      if (!person) return;
      const p = mem ? mem.p : { section: ros.section, sub: ros.sub, block: ros.block, lot: ros.lot, grave: ros.grave };
      const loc = (mem && mem.lat != null)
        ? { lat: mem.lat, lng: mem.lng, acc: 8, level: 'gps' }
        : CS.locate(model, p) || { lat: lot.lat, lng: lot.lng, acc: 12, level: 'lot' };
      sheet.style.display = 'none';
      openGuide({
        name: person.name, ln: person.last || '', by: person.by || null, dy: person.dy || null,
        mid: mem ? mem.mid : (ros && ros.mem ? ros.mem.mid : null),
        rosKey: ros ? ros.key : null,
        loc, pBest: p && p.section ? p : null, pRos: ros ? p : null,
        plot: mem ? mem.plot : '',
      }, model);
    });
  }
}

/* ---------------- main map ---------------- */
let mainMap = null;
function imageryPref() { return store.prefs.imagery !== false; }
function ensureMap() {
  if (mainMap) return;
  mainMap = new MapView($('map-canvas'), gproj, {
    imagery: imageryPref(),
    onTap: (x, y) => {
      const hit = mainMap.hitTest(x, y);
      if (hit && hit.ref) { openGuide(hit.ref, hit.model); return; }
      if (hit && hit.mid && hit.model) {
        // grave dot: open the guide on that memorial at its true GPS position
        const mem = hit.model.memById.get(hit.mid);
        if (!mem) return;
        openGuide({
          name: mem.name, ln: mem.last || '', by: mem.by || null, dy: mem.dy || null,
          mid: mem.mid, rosKey: null,
          loc: { lat: mem.lat, lng: mem.lng, acc: 8, level: 'gps' },
          pBest: mem.p && mem.p.section ? mem.p : null, pRos: null,
          plot: mem.plot,
        }, hit.model);
        return;
      }
      if (hit && hit.occ && hit.model) { openLotSheet(hit); return; }
      if (hit && hit.reg && hit.model) {
        // register dot: open the guide on the roster burial at its located spot
        const r = hit.model.roster.find(x => x.key === hit.rosKey);
        if (!r) return;
        const loc = CS.locate(hit.model, { section: r.section, sub: r.sub, block: r.block, lot: r.lot, grave: r.grave });
        openGuide({
          name: r.name, ln: r.last || '', by: r.by || null, dy: r.dy || null,
          mid: r.mem ? r.mem.mid : null, rosKey: r.key, loc,
          pBest: null, pRos: { section: r.section, sub: r.sub, block: r.block, lot: r.lot, grave: r.grave },
          plot: '',
        }, hit.model);
      }
    },
  });
  $('map-zoom-in').addEventListener('click', () => mainMap.zoomAt(mainMap.w / 2, mainMap.h / 2, 1.35));
  $('map-zoom-out').addEventListener('click', () => mainMap.zoomAt(mainMap.w / 2, mainMap.h / 2, 0.74));
  $('map-fit').addEventListener('click', () => fitMap(true));
  $('map-imagery').classList.toggle('on', imageryPref());
  $('map-imagery').addEventListener('click', () => {
    store.prefs.imagery = !imageryPref();
    save();
    mainMap.imagery = imageryPref();
    if (guideMap) guideMap.imagery = imageryPref();
    $('map-imagery').classList.toggle('on', imageryPref());
    mainMap.draw();
  });
  $('map-locate').addEventListener('click', () => {
    geo.on();
    if (geo.pos) mainMap.centerOn(geo.pos.lat, geo.pos.lng, Math.max(mainMap.scale, 3));
    else toast('Waiting for GPS fix…');
  });
  geo.listeners.add(p => { if (mainMap) { mainMap.user = p; if ($('panel-map').classList.contains('active')) mainMap.draw(); } });
}
window.addEventListener('resize', () => {
  if (mainMap) mainMap.resize();
  if (guideMap) guideMap.resize();
});
function refreshMapLayers() {
  if (!mainMap) return;
  mainMap.layers = buildLayers(activeCemList());
  mainMap.user = geo.pos;
  mainMap.draw();
}
function fitCemetery(model) {
  const pts = [{ lat: model.meta.cem.lat, lng: model.meta.cem.lng }];
  const cache = modelLayerCache(model);
  pts.push(...cache.lots, ...cache.sections);
  for (const r of model.requests) if (r.loc) pts.push(r.loc);
  mainMap.fitTo(pts, 150);
}
let mapFitState = 'cem'; // toggles: cemetery view <-> whole region
function fitMap(toggle) {
  if (!mainMap) return;
  const ids = activeCemList();
  if (toggle === true) mapFitState = mapFitState === 'cem' ? 'region' : 'cem';
  if (ids.length === 1) {
    if (mapFitState === 'region' && toggle === true) {
      mainMap.fitTo(DS.cemeteries.map(c => ({ lat: c.data.meta.cem.lat, lng: c.data.meta.cem.lng })), 800);
    } else fitCemetery(getModel(ids[0]));
    return;
  }
  // "All nearby": a 28-mile region fit shows nothing useful at cemetery scale —
  // open on the most relevant single cemetery instead (where you are, or the
  // nearest one with open requests); ⛶ toggles out to the whole region
  if (mapFitState === 'region') {
    mainMap.fitTo(DS.cemeteries.map(c => ({ lat: c.data.meta.cem.lat, lng: c.data.meta.cem.lng })), 800);
    return;
  }
  let best = null, bestD = Infinity;
  const from = geo.pos || DS.home;
  for (const c of DS.cemeteries) {
    if (!requestRowsFor(c).length) continue;
    const d = CS.distM(from.lat, from.lng, c.data.meta.cem.lat, c.data.meta.cem.lng);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best) fitCemetery(getModel(best.id));
  else mainMap.fitTo(DS.cemeteries.map(c => ({ lat: c.data.meta.cem.lat, lng: c.data.meta.cem.lng })), 800);
}

/* ---------------- search ---------------- */
let searchTimer = null;
$('search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 160);
});
function renderSearch() {
  const q = $('search-input').value;
  const wrap = $('search-results');
  if (!q.trim()) { wrap.innerHTML = ''; return; }
  if (normFilter(q).replace(/ /g, '').length < 2) {
    wrap.innerHTML = '<div class="empty-state">Type at least two letters…</div>';
    return;
  }
  const res = CS.searchAll(ensureAllModels(), q, { perCem: 6, total: 120 });
  if (!res.length) { wrap.innerHTML = '<div class="empty-state">No matches in any of the ' + DS.cemeteries.length + ' cemeteries.</div>'; return; }
  wrap.innerHTML = '';
  if (res.truncated) {
    const note = document.createElement('div');
    note.className = 'small';
    note.style.padding = '4px 2px 8px';
    note.textContent = 'Showing up to 6 matches per cemetery, nearest cemeteries first — add a first name to narrow it down.';
    wrap.appendChild(note);
  }
  for (const { kind, item, model } of res) {
    const div = document.createElement('div');
    div.className = 'sres';
    const p = kind === 'mem' ? item.p : { section: item.section, sub: item.sub, block: item.block, lot: item.lot, grave: item.grave };
    const loc = item.lat != null && item.lng != null ? { lat: item.lat, lng: item.lng, acc: 8, level: 'gps' } : (p && p.section ? CS.locate(model, p) : null);
    const plotStr = kind === 'mem' ? item.plot :
      [item.section + (item.sub ? ' Sub ' + item.sub : ''), item.block && 'Blk ' + item.block, item.lot && 'Lot ' + item.lot, item.grave && 'Gr ' + item.grave].filter(Boolean).join(' ');
    const ros = kind === 'ros' ? item : item.ros;
    const bsaUid = model.cem.bsaUid;
    div.innerHTML = `
      <div class="tname">${esc(item.name)}<span class="years">${CS.yearsOf(item)}</span>
        ${item.veteran ? '<span class="badge stone">vet</span>' : ''}
        ${kind === 'mem' && item.hasGravePhoto ? '<span title="stone photographed">📷</span>' : ''}
        ${kind === 'mem' && item.hasRequest ? '<span class="badge rust">photo requested</span>' : ''}
      </div>
      <div class="tmeta"><span class="lbl">${esc(model.cem.name)}</span> ${esc(plotStr || 'no plot recorded')}${kind === 'ros' ? ' · <span class="lbl">city register</span>' : ''}</div>
      <div>${loc ? `<span class="loc-chip"><span class="dot ${loc.level === 'lot' || loc.level === 'gps' ? 'q-lot' : loc.level === 'section' ? 'q-section' : 'q-block'}"></span>${loc.level} ${fmtAcc(loc.acc)}</span>` : ''}</div>
      <div class="trow-actions">
        ${loc ? '<button class="mini act-guide">➤ Guide</button><button class="mini act-map">Map</button>' : ''}
        ${kind === 'mem' ? `<a class="mini" style="text-decoration:none;" href="https://www.findagrave.com/memorial/${item.mid}" target="_blank" rel="noopener">Find a Grave ↗</a>` : ''}
        ${ros && ros.key > 0 && bsaUid ? `<a class="mini" style="text-decoration:none;" href="https://www.bsaonline.com/SiteSearch/PropertyDetails?uid=${bsaUid}&RecordKey=${ros.key}&RecordKeyType=10&ReferenceKey=${ros.key}&ReferenceType=6&SearchFocus=Cemetery%20Management&SearchCategory=Name&SearchText=x&PageIndex=1" target="_blank" rel="noopener">Register ↗</a>` : ''}
      </div>`;
    const target = {
      name: item.name, ln: item.last || '', by: item.by || null, dy: item.dy || null,
      mid: kind === 'mem' ? item.mid : (item.mem ? item.mem.mid : null),
      rosKey: ros && ros.key ? ros.key : null,
      loc, pBest: p && p.section ? p : null, pRos: kind === 'ros' ? p : null,
      plot: plotStr,
    };
    const g = div.querySelector('.act-guide');
    if (g) g.addEventListener('click', () => openGuide(target, model));
    const mm = div.querySelector('.act-map');
    if (mm) mm.addEventListener('click', () => {
      store.prefs.activeCem = String(model.cem.id);
      save();
      renderCemSelect();
      switchTab('map');
      mainMap.layers.targets.push({ lat: loc.lat, lng: loc.lng, color: '#a07a2c', label: item.name.split(' ').pop(), ref: target, model, r: 7 });
      mainMap.highlight = { lat: loc.lat, lng: loc.lng, acc: loc.acc };
      mainMap.centerOn(loc.lat, loc.lng, Math.max(mainMap.scale, 4));
    });
    wrap.appendChild(div);
  }
}

/* ---------------- data tab ---------------- */
function renderDataInfo() {
  const lines = [];
  lines.push(`<strong>${DS.cemeteries.length} cemeteries</strong> within ${DS.radiusMiles || '—'} mi · dataset generated <strong>${esc(DS.generated || '?')}</strong>`);
  const totReq = DS.cemeteries.reduce((s, c) => s + c.data.requests.length, 0);
  const totMem = DS.cemeteries.reduce((s, c) => s + c.data.memorials.length, 0);
  const totAnch = builtModels().reduce((s, m) => s + m.memorials.filter(x => x.lat != null).length, 0);
  lines.push(`${totReq} open photo requests · ${totMem.toLocaleString()} memorials (${totAnch.toLocaleString()} GPS anchors in built models) · ${Object.keys(store.progress).length} graves with saved progress`);
  for (const c of DS.cemeteries.slice(0, 50)) {
    lines.push(`&nbsp;&nbsp;· ${esc(c.name)} — ${c.data.requests.length} req, ${c.data.memorials.length.toLocaleString()} memorials${c.data.roster && c.data.roster.length ? ', register ✓' : ''}${c.miles != null ? ', ' + c.miles + ' mi' : ''}${c.contact ? '<br>&nbsp;&nbsp;&nbsp;&nbsp;📞 ' + esc(c.contact) : ''}`);
  }
  $('dataset-info').innerHTML = lines.join('<br>');

  // when served by the Flask container, show live refresh status
  const staticMsg = () => {
    $('server-status').innerHTML = '<span class="badge outline">static hosting</span> data updates when the site is redeployed — or via the imports below.';
  };
  if (typeof fetch === 'function' && location.protocol !== 'file:') {
    fetch('./api/status', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(st => {
      if (!st) { staticMsg(); return; }
      $('server-status').innerHTML = `<span class="badge">auto-refresh on</span> server refreshes every ${st.refreshHours} h · last build: ${esc(st.generated || '?')} (${st.cemeteries} cemeteries, ${st.requests} requests)${st.refreshing ? ' · <em>refreshing now…</em>' : ''}${st.lastError ? ' · ⚠ ' + esc(st.lastError) : ''}`;
    }).catch(staticMsg);
  } else staticMsg();

  const bk = CS.bookmarklets(dataCemId());
  $('bkm-requests').setAttribute('href', bk.requests);
  $('bkm-memorials').setAttribute('href', bk.memorials);
  renderDataCemSelect();
}
function renderDataCemSelect() {
  const sel = $('data-cem');
  if (sel.options.length) return;
  for (const c of DS.cemeteries) {
    const o = document.createElement('option');
    o.value = String(c.id);
    o.textContent = c.name;
    sel.appendChild(o);
  }
}
function dataCemId() {
  const sel = $('data-cem');
  return +(sel.value || (DS.cemeteries[0] && DS.cemeteries[0].id) || 0);
}
$('data-cem').addEventListener('change', () => {
  const bk = CS.bookmarklets(dataCemId());
  $('bkm-requests').setAttribute('href', bk.requests);
  $('bkm-memorials').setAttribute('href', bk.memorials);
});
for (const [id, key] of [['bkm-requests', 'requests'], ['bkm-memorials', 'memorials']]) {
  $(id).addEventListener('click', ev => {
    ev.preventDefault();
    const bk = CS.bookmarklets(dataCemId());
    navigator.clipboard && navigator.clipboard.writeText(bk[key]).then(
      () => toast('Bookmarklet code copied — create a new bookmark and paste it as the URL'),
      () => toast('Copy failed — long-press the link and copy it instead')
    );
  });
}

function rebuild() {
  models.clear();
  ensureAllModels();
  if (mainMap) refreshMapLayers();
  renderCemSelect();
  renderWalk();
  renderDataInfo();
  updateStats();
}

/* validate a candidate update by building a throwaway model BEFORE committing */
function commitUpdates(cemId, patch, statusEl, okMsg) {
  const cid = String(cemId);
  const cem = cemById.get(cid);
  if (!cem) { statusEl.textContent = '⚠ Unknown cemetery.'; return false; }
  const candidate = Object.assign({}, store.updates[cid] || {}, patch);
  try { CS.buildModel(cem.data, candidate); }
  catch (e) {
    statusEl.textContent = '⚠ Update rejected — it would break the app (' + e.message + ')';
    return false;
  }
  store.updates[cid] = candidate;
  saveUpdates();
  rebuild();
  statusEl.textContent = okMsg;
  return true;
}

/* file/drop helpers */
function wireDrop(dropId, fileId, handler) {
  const dz = $(dropId), fi = $(fileId);
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { if (fi.files[0]) handler(fi.files[0]); fi.value = ''; });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
  });
}
let xlsxLoading = null;
function ensureXlsx() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (xlsxLoading) return xlsxLoading;
  xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = './xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s2.onload = resolve;
      s2.onerror = () => reject(new Error('Could not load spreadsheet library'));
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}
function readSheetFile(file) {
  return ensureXlsx().then(() => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = e => {
      try {
        const ext = file.name.toLowerCase().split('.').pop();
        const wb = ext === 'csv'
          ? XLSX.read(e.target.result, { type: 'string', raw: false })
          : XLSX.read(e.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }));
      } catch (err) { reject(err); }
    };
    if (file.name.toLowerCase().endsWith('.csv')) reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  }));
}

/* requests update */
function applyRequests(result, sourceName) {
  if (result.error) { $('fag-status').textContent = '⚠ ' + result.error; return; }
  const cid = dataCemId();
  const cem = cemById.get(String(cid));
  // bookmarklets fetch whatever cemetery's page they were created for — catch mismatches
  const srcCid = result.requests.length && result.requests[0].cid;
  if (srcCid && srcCid !== cid) {
    const srcCem = cemById.get(String(srcCid));
    if (srcCem) {
      if (!confirm(`This data is for ${srcCem.name}, but "${cem ? cem.name : cid}" is selected. Apply it to ${srcCem.name} instead?`)) {
        $('fag-status').textContent = 'Cancelled — pick the matching cemetery above.';
        return;
      }
      return applyRequestsTo(srcCid, srcCem, result, sourceName);
    }
    $('fag-status').textContent = `⚠ This data is for Find a Grave cemetery #${srcCid}, which isn't in your dataset.`;
    return;
  }
  applyRequestsTo(cid, cem, result, sourceName);
}
function applyRequestsTo(cid, cem, result, sourceName) {
  const cur = cem ? requestRowsFor(cem).length : 0;
  if (!result.requests.length &&
      !confirm(`The snapshot has ZERO open requests for ${cem ? cem.name : 'this cemetery'} — replace the current ${cur}? (Means everything was fulfilled or removed.)`)) {
    $('fag-status').textContent = 'Cancelled.';
    return;
  }
  if (result.requests.length && cur && result.requests.length < cur * 0.5 &&
      !confirm(`This replaces the current ${cur} photo requests for ${cem.name} with only ${result.requests.length}. Continue?`)) {
    $('fag-status').textContent = 'Cancelled.';
    return;
  }
  if (commitUpdates(cid, { requests: result.requests, requestsAsOf: new Date().toISOString().substring(0, 10) },
    $('fag-status'), '✓ ' + result.requests.length + ' requests loaded from ' + sourceName)) {
    toast(result.requests.length + ' photo requests updated');
  }
}
function dataCemCoords() {
  const cem = cemById.get(String(dataCemId()));
  return cem ? cem.data.meta.cem : DS.home;
}
$('btn-fag-apply').addEventListener('click', () => {
  const text = $('fag-input').value.trim();
  if (!text) { $('fag-status').textContent = 'Paste JSON/CSV first, or drop a file.'; return; }
  if (text[0] === '[' || text[0] === '{') applyRequests(CS.parseRequestsJson(text, dataCemCoords()), 'pasted JSON');
  else {
    ensureXlsx().then(() => {
      const wb = XLSX.read(text, { type: 'string', raw: false });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
      applyRequests(CS.parseRequestsSheet(rows), 'pasted CSV');
    }).catch(e => { $('fag-status').textContent = '⚠ ' + e.message; });
  }
});
wireDrop('fag-drop', 'fag-file', file => {
  if (file.name.toLowerCase().endsWith('.json')) {
    file.text().then(t => applyRequests(CS.parseRequestsJson(t, dataCemCoords()), file.name));
  } else {
    readSheetFile(file).then(rows => applyRequests(CS.parseRequestsSheet(rows), file.name))
      .catch(e => { $('fag-status').textContent = '⚠ ' + e.message; });
  }
});

/* memorials update */
$('btn-mem-apply').addEventListener('click', () => {
  const text = $('mem-input').value.trim();
  if (!text) { $('mem-status').textContent = 'Paste the bookmarklet JSON first.'; return; }
  const cid = dataCemId();
  const cem = cemById.get(String(cid));
  const result = CS.parseMemorialsJson(text, cem ? cem.data.meta.cem : DS.home);
  if (result.error) { $('mem-status').textContent = '⚠ ' + result.error; return; }
  if (!result.memorials.length) { $('mem-status').textContent = '⚠ No memorials in that JSON.'; return; }
  if (commitUpdates(cid, { memorials: result.memorials, memorialsAsOf: new Date().toISOString().substring(0, 10) },
    $('mem-status'), '✓ ' + result.memorials.length + ' memorials loaded')) {
    toast(result.memorials.length + ' memorials updated');
  }
});

/* roster update */
function applyRoster(result, sourceName) {
  if (result.error) { $('bsa-status').textContent = '⚠ ' + result.error; return; }
  if (!result.roster.length) { $('bsa-status').textContent = '⚠ No rows recognized in ' + sourceName; return; }
  const cid = dataCemId();
  const cem = cemById.get(String(cid));
  const cur = cem && cem.data.roster ? cem.data.roster.length : 0;
  if (cur && result.roster.length < cur * 0.5 &&
      !confirm(`This replaces the current ${cur}-record register for ${cem.name} with only ${result.roster.length} rows. Continue?`)) {
    $('bsa-status').textContent = 'Cancelled.';
    return;
  }
  commitUpdates(cid, { roster: result.roster },
    $('bsa-status'), '✓ ' + result.roster.length + ' register rows loaded from ' + sourceName);
}
function rosterProfile() { return dataCemId() === 1252 ? 'oakgrove' : 'generic'; }
$('btn-bsa-apply').addEventListener('click', () => {
  const text = $('bsa-input').value.trim();
  if (!text) { $('bsa-status').textContent = 'Paste roster rows first, or drop a file.'; return; }
  applyRoster(CS.parseRosterText(text, rosterProfile()), 'pasted text');
});
wireDrop('bsa-drop', 'bsa-file', file => {
  readSheetFile(file).then(rows => applyRoster(CS.parseRosterSheet(rows, rosterProfile()), file.name))
    .catch(e => { $('bsa-status').textContent = '⚠ ' + e.message; });
});

/* export / import / reset / revert */
$('btn-export').addEventListener('click', () => {
  const payload = { app: 'cemetery-search', v: 3, exported: new Date().toISOString(), progress: store.progress, updates: store.updates, prefs: store.prefs };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cemetery-search-backup-' + new Date().toISOString().substring(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then(t => {
    const data = JSON.parse(t);
    if (data.app !== 'cemetery-search' && !data.progress) throw new Error('Not a Cemetery Search backup');
    const inProg = (data.progress && typeof data.progress === 'object' && !Array.isArray(data.progress)) ? data.progress : {};
    const curN = Object.keys(store.progress).length, inN = Object.keys(inProg).length;
    if (curN && !confirm(`Import backup${data.exported ? ' from ' + String(data.exported).substring(0, 10) : ''}: ${inN} progress entries (newest-per-grave wins). Any valid dataset updates in the backup replace the current ones for those cemeteries. Continue?`)) return;
    for (const [k, v] of Object.entries(inProg)) {
      if (!store.progress[k] || (v && v.ts || 0) >= (store.progress[k].ts || 0)) store.progress[k] = v;
    }
    // restore dataset updates too — but only entries that build cleanly
    const inUpd = (data.updates && typeof data.updates === 'object' && !Array.isArray(data.updates)) ? data.updates : {};
    let updOk = 0, updBad = 0;
    for (const [cid, u] of Object.entries(inUpd)) {
      const cem = cemById.get(String(cid));
      if (!cem || !u || typeof u !== 'object') { updBad++; continue; }
      try {
        CS.buildModel(cem.data, u);
        store.updates[String(cid)] = u;
        updOk++;
      } catch (err) { updBad++; }
    }
    flushSave();
    if (updOk) saveUpdates();
    rebuild();
    toast('Backup imported ✓' + (updOk ? ` (+${updOk} dataset updates)` : '') + (updBad ? ` — ${updBad} invalid update(s) skipped` : ''));
  }).catch(err => toast('Import failed: ' + err.message));
  e.target.value = '';
});
$('btn-reset').addEventListener('click', () => {
  if (!confirm('Clear all check-offs, notes and saved GPS — here AND in the server backup? (Dataset updates are kept.)')) return;
  // tombstone everything (newest ts) so the server backup adopts the reset
  // instead of restoring the old entries on next sync
  const now = Date.now();
  for (const pk of Object.keys(store.progress)) store.progress[pk] = { ts: now };
  flushSave();
  syncProgress().then(() => {
    store.progress = {};
    flushSave();
    rebuild();
  });
});
$('btn-revert').addEventListener('click', () => {
  if (!confirm('Discard all manual dataset updates and return to the served data? Progress is kept.')) return;
  store.updates = {};
  saveUpdates();
  rebuild();
  toast('Reverted to served dataset');
});

/* ---------------- offline field pack (aerial tiles over Wi-Fi) ---------------- */
// Mirrors the server's prefetch zooms; fetching each ./tiles/ URL routes
// through the service worker's cache-first tile handler, which stores it —
// after that the tile serves forever with zero signal.
const PACK_ZOOMS = [15, 16, 17, 18, 19];
function tileXY(z, lat, lng) {
  const n = Math.pow(2, z), r = lat * Math.PI / 180;
  return {
    x: Math.floor((lng + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n),
  };
}
function packTilesFor(cemIds) {
  const urls = [];
  for (const cid of cemIds) {
    const model = getModel(cid);
    if (!model) continue;
    const cc = model.cem.data.meta.cem;
    // cover the whole grounds: centroid plus every mapped point, padded 120 m
    let minLat = cc.lat, maxLat = cc.lat, minLng = cc.lng, maxLng = cc.lng;
    const cache = modelLayerCache(model);
    for (const arr of [cache.graves, cache.lots]) {
      for (const p of arr) {
        if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
      }
    }
    const padLat = 120 / 111194, padLng = padLat / Math.cos(cc.lat * Math.PI / 180);
    minLat -= padLat; maxLat += padLat; minLng -= padLng; maxLng += padLng;
    for (const z of PACK_ZOOMS) {
      const a = tileXY(z, maxLat, minLng), b = tileXY(z, minLat, maxLng);
      for (let x = a.x; x <= b.x; x++)
        for (let y = a.y; y <= b.y; y++)
          urls.push(`./tiles/${z}/${x}/${y}.jpg`);
    }
  }
  return [...new Set(urls)];
}
let packRunning = false;
async function downloadPack(cemIds, label) {
  if (packRunning) { toast('A download is already running'); return; }
  packRunning = true;
  const st = $('pack-status');
  const urls = packTilesFor(cemIds);
  let done = 0, failed = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (urls.length) {
      const u = urls.pop();
      try { const r = await fetch(u); if (!r.ok) failed++; } catch (e) { failed++; }
      done++;
      if (done % 25 === 0 || !urls.length) st.textContent = `${label}: ${done} tiles cached${failed ? `, ${failed} unavailable` : ''}…`;
    }
  });
  await Promise.all(workers);
  st.textContent = `${label}: done — ${done - failed} tiles stored on this device${failed ? ` (${failed} unavailable)` : ''}. The map now works with no signal here.`;
  packRunning = false;
}
$('btn-pack-active').addEventListener('click', () => {
  const a = activeCem();
  if (a === 'all') { toast('Pick a cemetery first (the selector at the top), or use Download all'); return; }
  downloadPack([a], getModel(a) ? getModel(a).cem.name : 'cemetery');
});
$('btn-pack-all').addEventListener('click', () => {
  if (!confirm('Download aerial imagery for all 38 cemeteries? Roughly 40–80 MB — do this on Wi-Fi.')) return;
  downloadPack(DS.cemeteries.map(c => String(c.id)), 'all cemeteries');
});

/* ---------------- walk controls ---------------- */
let walkTimer = null;
$('walk-filter').addEventListener('input', () => { clearTimeout(walkTimer); walkTimer = setTimeout(renderWalk, 150); });
$('walk-sort').addEventListener('change', () => {
  if ($('walk-sort').value === 'near') geo.on();
  renderWalk();
});
$('walk-hidedone').addEventListener('change', renderWalk);
$('walk-finished').addEventListener('click', () => {
  walkMode = walkMode === 'finished' ? 'open' : 'finished';
  $('walk-finished').classList.toggle('on', walkMode === 'finished');
  renderWalk();
});
$('gps-chip').addEventListener('click', () => geo.toggle());
// GPS-driven re-sorting: only when the user actually moved (a re-render per fix
// would fight the user's scrolling every 1-2 s)
let lastNearRender = null;
geo.listeners.add(p => {
  if (!$('panel-walk').classList.contains('active')) return;
  updateNearestBanner();
  if ($('walk-sort').value !== 'near') return;
  if (lastNearRender && CS.distM(p.lat, p.lng, lastNearRender.lat, lastNearRender.lng) < 15) return;
  lastNearRender = { lat: p.lat, lng: p.lng };
  renderWalk();
});

/* ---------------- service worker ---------------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline install unavailable */ });
  });
}

/* ---------------- boot ---------------- */
$('subtitle').textContent = DS.cemeteries.length > 1
  ? `${DS.cemeteries.length} local cemeteries · ${DS.generated || ''}`
  : ((DS.cemeteries[0] && DS.cemeteries[0].name) || 'No dataset');
// live counts everywhere copy mentions them — static numbers go stale
{
  const totMem = DS.cemeteries.reduce((s, c) => s + c.data.memorials.length, 0);
  const totRos = DS.cemeteries.reduce((s, c) => s + ((c.data.roster && c.data.roster.length) || 0), 0);
  if (totMem) {
    $('search-input').placeholder = `Search any name — ${(Math.floor(totMem / 1000))},000+ burials in ${DS.cemeteries.length} cemeteries, offline`;
    const el = $('install-count');
    if (el) el.textContent = `all ${Math.floor((totMem + totRos) / 1000)},000+ records, the maps,`;
  }
}
renderCemSelect();
renderWalk();
renderDataInfo();
updateStats();
})();
