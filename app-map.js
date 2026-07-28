/* ==========================================================
   Cemetery Search — canvas map renderer (layer-based).
   World space: meters east/north of a fixed datum (home point),
   so any number of cemeteries render on one canvas. Screen: px, y down.
   Layers are plain lat/lng lists prepared by the UI layer:
   { lots:[{lat,lng,label}], blocks:[{lat,lng,label}], roads:[{lat,lng}],
     sections:[{lat,lng,label}], cems:[{lat,lng,label}], targets:[...],
     graves:[{lat,lng,label,ph}] — GPS-tagged memorials at true position }
   ========================================================== */
(function () {
'use strict';

// low enough to fit the whole multi-cemetery region on a phone canvas
const MIN_SCALE = 0.002;

/* ---------------- aerial imagery (NAIP, public domain) ---------------- */
const NAIP_EXPORT = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
const MERC_R = 6378137, MERC_HALF = Math.PI * MERC_R;
const tileCache = new Map();      // 'z/x/y' -> {img, state:'loading'|'ok'|'err', direct}
let serverTilesOk = (typeof location !== 'undefined' && location.protocol !== 'file:');
const TILE_CACHE_MAX = 400;

function lngToTileX(z, lng) { return (lng + 180) / 360 * Math.pow(2, z); }
function latToTileY(z, lat) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function tileToLng(z, x) { return x / Math.pow(2, z) * 360 - 180; }
function tileToLat(z, y) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function tileDirectUrl(z, x, y) {
  const n = Math.pow(2, z), size = 2 * MERC_HALF / n;
  const xmin = -MERC_HALF + x * size, ymax = MERC_HALF - y * size;
  return `${NAIP_EXPORT}?bbox=${xmin},${ymax - size},${xmin + size},${ymax}&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image`;
}
function getTile(z, x, y, onReady) {
  const key = z + '/' + x + '/' + y;
  let t = tileCache.get(key);
  if (t) { tileCache.delete(key); tileCache.set(key, t); return t; } // LRU touch
  t = { img: new Image(), state: 'loading', direct: !serverTilesOk };
  tileCache.set(key, t);
  if (tileCache.size > TILE_CACHE_MAX) {
    for (const [k, v] of tileCache) {
      if (v.state !== 'loading') { tileCache.delete(k); break; }
    }
  }
  t.img.onload = () => { t.state = 'ok'; onReady && onReady(); };
  t.img.onerror = () => {
    if (!t.direct) {
      // server has no /tiles route (static hosting) — fall back to NAIP directly
      serverTilesOk = false;
      t.direct = true;
      t.img.src = tileDirectUrl(z, x, y);
    } else t.state = 'err';
  };
  t.img.src = t.direct ? tileDirectUrl(z, x, y) : ('./tiles/' + z + '/' + x + '/' + y + '.jpg');
  return t;
}

function MapView(canvas, proj, opts) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.proj = proj;                 // global projection (home-anchored)
  this.opts = opts || {};
  this.scale = 1.4;                 // px per meter
  this.cx = 0; this.cy = 0;         // world center (m east/north of datum)
  this.user = null;                 // {lat,lng,acc}
  this.layers = { lots: [], blocks: [], roads: [], sections: [], cems: [], targets: [], graves: [] };
  this.highlight = null;            // {lat,lng,acc}
  this.imagery = opts.imagery !== false;
  this._imageryDrawn = false;
  this._redrawQueued = false;
  this._pointers = new Map();
  this._lastPinch = null;
  this._bindings();
  this.resize();
}

MapView.prototype.queueRedraw = function () {
  if (this._redrawQueued) return;
  this._redrawQueued = true;
  requestAnimationFrame(() => { this._redrawQueued = false; this.draw(); });
};

MapView.prototype.drawImagery = function () {
  const ctx = this.ctx, w = this.w, h = this.h;
  this._imageryDrawn = false;
  if (!this.imagery) return;
  const tl = this.screenToWorld(0, 0), br = this.screenToWorld(w, h);
  const llTL = this.proj.toLL(tl.e, tl.n), llBR = this.proj.toLL(br.e, br.n);
  if (!isFinite(llTL.lat) || !isFinite(llBR.lat)) return;
  // pick the zoom whose native resolution best matches the current scale
  const midLat = (llTL.lat + llBR.lat) / 2;
  let z = Math.ceil(Math.log2(156543.03 * Math.cos(midLat * Math.PI / 180) * this.scale));
  z = Math.min(19, Math.max(13, z));
  const x0 = Math.floor(lngToTileX(z, llTL.lng)), x1 = Math.floor(lngToTileX(z, llBR.lng));
  const y0 = Math.floor(latToTileY(z, llTL.lat)), y1 = Math.floor(latToTileY(z, llBR.lat));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return; // safety net
  const onReady = () => this.queueRedraw();
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) continue;
      const t = getTile(z, x, y, onReady);
      if (t.state !== 'ok' || !t.img.naturalWidth) continue;
      const nw = this.llToScreen(tileToLat(z, y), tileToLng(z, x));
      const se = this.llToScreen(tileToLat(z, y + 1), tileToLng(z, x + 1));
      try {
        ctx.drawImage(t.img, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
        this._imageryDrawn = true;
      } catch (e) { /* decode edge case — skip tile */ }
    }
  }
  if (this._imageryDrawn) {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '9px JetBrains Mono, monospace';
    const txt = 'USGS NAIP imagery';
    ctx.fillText(txt, w - ctx.measureText(txt).width - 6, h - 5);
  }
};

MapView.prototype.resize = function () {
  const dpr = window.devicePixelRatio || 1;
  const rect = this.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  this.canvas.width = Math.round(rect.width * dpr);
  this.canvas.height = Math.round(rect.height * dpr);
  this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  this.w = rect.width; this.h = rect.height;
  this.draw();
};

MapView.prototype.worldToScreen = function (e, n) {
  return { x: this.w / 2 + (e - this.cx) * this.scale, y: this.h / 2 - (n - this.cy) * this.scale };
};
MapView.prototype.screenToWorld = function (x, y) {
  return { e: this.cx + (x - this.w / 2) / this.scale, n: this.cy - (y - this.h / 2) / this.scale };
};
MapView.prototype.llToScreen = function (lat, lng) {
  const en = this.proj.toEN(lat, lng);
  return this.worldToScreen(en.e, en.n);
};

MapView.prototype.fitTo = function (points, minSpanM) {
  // points: [{lat,lng}] — fit view around them
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, any = false;
  for (const p of points) {
    if (p == null || p.lat == null) continue;
    const en = this.proj.toEN(p.lat, p.lng);
    if (!isFinite(en.e) || !isFinite(en.n)) continue;
    minE = Math.min(minE, en.e); maxE = Math.max(maxE, en.e);
    minN = Math.min(minN, en.n); maxN = Math.max(maxN, en.n);
    any = true;
  }
  if (!any) { this.cx = 0; this.cy = 0; this.scale = 1; this.draw(); return; }
  // enforce minSpanM as a real minimum span (a single point must not over-zoom)
  const span = Math.max(minSpanM || 120, maxE - minE, maxN - minN);
  const dE = Math.max(0, span - (maxE - minE)) / 2, dN = Math.max(0, span - (maxN - minN)) / 2;
  minE -= dE; maxE += dE; minN -= dN; maxN += dN;
  const padE = span * 0.08 + 12, padN = span * 0.08 + 12;
  minE -= padE; maxE += padE; minN -= padN; maxN += padN;
  this.cx = (minE + maxE) / 2; this.cy = (minN + maxN) / 2;
  this.scale = Math.min(60, Math.max(MIN_SCALE, Math.min(this.w / (maxE - minE), this.h / (maxN - minN))));
  this.draw();
};

MapView.prototype.centerOn = function (lat, lng, scale) {
  const en = this.proj.toEN(lat, lng);
  this.cx = en.e; this.cy = en.n;
  if (scale) this.scale = scale;
  this.draw();
};

/* ---------------- drawing ---------------- */
MapView.prototype.draw = function () {
  const ctx = this.ctx, w = this.w, h = this.h;
  if (!w) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ece5d4';
  ctx.fillRect(0, 0, w, h);
  this.drawImagery();
  const onImg = this._imageryDrawn;

  const s = this.scale;
  const L = this.layers;
  const inView = p => p.x > -25 && p.y > -25 && p.x < w + 25 && p.y < h + 25;
  const halo = (txt, x, y) => { // readable labels on top of photography
    if (!onImg) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;
    ctx.strokeText(txt, x, y);
  };

  // graves: GPS-tagged memorials at their true position (under the plat grid).
  // Solid dot = stone photographed, ring = not — in the field a solid dot is a
  // stone you can navigate by.
  if (s > 0.7 && L.graves.length) {
    const showNames = s > 4.5;
    ctx.font = 'italic 8px JetBrains Mono, monospace';
    for (const pt of L.graves) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      ctx.lineWidth = 1.2;   // halo() bumps it to 3 — reset per dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
      if (pt.ph) {
        ctx.fillStyle = onImg ? 'rgba(255,253,247,0.95)' : 'rgba(74,93,58,0.8)';
        ctx.fill();
        if (onImg) { ctx.strokeStyle = 'rgba(20,24,15,0.9)'; ctx.stroke(); }
      } else {
        ctx.strokeStyle = onImg ? 'rgba(255,253,247,0.9)' : 'rgba(74,93,58,0.65)';
        ctx.stroke();
      }
      if (showNames && pt.label) {
        halo(pt.label, p.x + 4, p.y - 3);
        ctx.fillStyle = onImg ? 'rgba(20,24,15,0.95)' : 'rgba(60,72,48,0.85)';
        ctx.fillText(pt.label, p.x + 4, p.y - 3);
      }
    }
  }
  // lot grid
  if (s > 0.55 && L.lots.length) {
    const showNums = s > 3.4;
    ctx.font = '9px JetBrains Mono, monospace';
    for (const pt of L.lots) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      if (onImg) { // white pip with dark rim reads on any photo
        ctx.fillStyle = 'rgba(20,24,15,0.9)';
        ctx.fillRect(p.x - 1.9, p.y - 1.9, 3.8, 3.8);
        ctx.fillStyle = 'rgba(255,253,247,0.95)';
        ctx.fillRect(p.x - 1.1, p.y - 1.1, 2.2, 2.2);
      } else {
        ctx.fillStyle = 'rgba(148,138,118,0.75)';
        ctx.fillRect(p.x - 1.2, p.y - 1.2, 2.4, 2.4);
      }
      if (showNums && pt.label) {
        halo(pt.label, p.x + 3, p.y + 3);
        ctx.fillStyle = onImg ? 'rgba(20,24,15,0.95)' : 'rgba(80,72,58,0.85)';
        ctx.fillText(pt.label, p.x + 3, p.y + 3);
      }
    }
  }
  // roads (redundant over photography)
  if (s > 0.7 && !onImg) {
    ctx.fillStyle = 'rgba(110,101,87,0.5)';
    ctx.font = '9px JetBrains Mono, monospace';
    for (const pt of L.roads) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (inView(p)) ctx.fillText('· road ·', p.x - 16, p.y);
    }
  }
  // block letters
  if (s > 0.8) {
    ctx.font = 'bold ' + Math.min(15, Math.max(10, s * 4)) + 'px JetBrains Mono, monospace';
    for (const pt of L.blocks) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      halo(pt.label, p.x, p.y);
      ctx.fillStyle = onImg ? 'rgba(30,44,22,0.95)' : 'rgba(74,93,58,0.8)';
      ctx.fillText(pt.label, p.x, p.y);
    }
  }
  // section names
  ctx.font = 'italic 600 ' + Math.min(17, Math.max(11, s * 9)) + 'px Cormorant Garamond, serif';
  if (s > 0.5) {
    for (const pt of L.sections) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      const tw = ctx.measureText(pt.label).width;
      halo(pt.label, p.x - tw / 2, p.y);
      ctx.fillStyle = onImg ? 'rgba(30,44,22,0.95)' : 'rgba(44,58,36,0.55)';
      ctx.fillText(pt.label, p.x - tw / 2, p.y);
    }
  }
  // cemetery names (visible when zoomed out)
  ctx.font = 'italic 700 15px Cormorant Garamond, serif';
  for (const pt of L.cems) {
    const p = this.llToScreen(pt.lat, pt.lng);
    if (p.x < -150 || p.y < -30 || p.x > w + 150 || p.y > h + 30) continue;
    const tw = ctx.measureText(pt.label).width;
    halo(pt.label, p.x - tw / 2, p.y - 10);
    ctx.fillStyle = 'rgba(20,24,15,0.9)';
    ctx.fillText(pt.label, p.x - tw / 2, p.y - 10);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // highlight ring
  if (this.highlight) {
    const p = this.llToScreen(this.highlight.lat, this.highlight.lng);
    const rpx = Math.max(10, (this.highlight.acc || 10) * s);
    ctx.beginPath();
    ctx.arc(p.x, p.y, rpx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(139,58,31,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(139,58,31,0.6)';
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // targets
  for (const t of L.targets) {
    const p = this.llToScreen(t.lat, t.lng);
    if (!inView(p)) continue;
    const r = t.r || 5.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = t.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,24,15,0.75)';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (t.label && s > 2.1) {
      ctx.fillStyle = 'rgba(20,24,15,0.92)';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(t.label, p.x + r + 3, p.y + 3);
    }
  }

  // user position
  if (this.user) {
    const p = this.llToScreen(this.user.lat, this.user.lng);
    if (this.user.acc) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, this.user.acc * s), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(43,92,122,0.13)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#2b5c7a';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // north arrow + scale bar
  ctx.fillStyle = 'rgba(20,24,15,0.75)';
  ctx.font = 'bold 12px JetBrains Mono, monospace';
  ctx.fillText('N ↑', 10, 20);
  const target = 90 / s; // aim for a bar ~90 px
  const steps = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const barM = steps.find(x => x >= target) || 10000;
  ctx.strokeStyle = 'rgba(20,24,15,0.75)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(10, h - 14);
  ctx.lineTo(10 + barM * s, h - 14);
  ctx.stroke();
  ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(barM >= 1000 ? (barM / 1000 + ' km') : (barM + ' m'), 12, h - 20);
};

/* ---------------- interaction ---------------- */
MapView.prototype._bindings = function () {
  const c = this.canvas;
  let moved = false;
  c.addEventListener('pointerdown', ev => {
    c.setPointerCapture(ev.pointerId);
    this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, sx: ev.clientX, sy: ev.clientY });
    this._lastPinch = null; // pointer count changed: re-baseline any pinch
    if (this._pointers.size === 1) moved = false;
  });
  c.addEventListener('pointermove', ev => {
    if (!this._pointers.has(ev.pointerId)) return;
    const prev = this._pointers.get(ev.pointerId);
    const cur = { x: ev.clientX, y: ev.clientY, sx: prev.sx, sy: prev.sy };
    if (this._pointers.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y;
      if (Math.hypot(cur.x - prev.sx, cur.y - prev.sy) > 6) moved = true;
      this.cx -= dx / this.scale;
      this.cy += dy / this.scale;
      this._pointers.set(ev.pointerId, cur);
      this.queueRedraw();
    } else if (this._pointers.size === 2) {
      moved = true;
      this._pointers.set(ev.pointerId, cur);
      const pts = [...this._pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this._lastPinch) {
        const f = dist / this._lastPinch;
        const rect = c.getBoundingClientRect();
        this.zoomAt((pts[0].x + pts[1].x) / 2 - rect.left, (pts[0].y + pts[1].y) / 2 - rect.top, f);
      }
      this._lastPinch = dist;
    }
  });
  const up = ev => {
    if (!this._pointers.has(ev.pointerId)) return;
    this._pointers.delete(ev.pointerId);
    this._lastPinch = null;
    if (this._pointers.size === 0 && !moved && ev.type === 'pointerup' && this.opts.onTap) {
      const rect = c.getBoundingClientRect();
      this.opts.onTap(ev.clientX - rect.left, ev.clientY - rect.top);
    }
  };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  c.addEventListener('wheel', ev => {
    ev.preventDefault();
    const rect = c.getBoundingClientRect();
    this.zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });
};

MapView.prototype.zoomAt = function (px, py, factor) {
  const before = this.screenToWorld(px, py);
  this.scale = Math.min(60, Math.max(MIN_SCALE, this.scale * factor));
  const after = this.screenToWorld(px, py);
  this.cx += before.e - after.e;
  this.cy += before.n - after.n;
  this.queueRedraw();
};

MapView.prototype.hitTest = function (x, y, radius) {
  let best = null, bestD = radius || 18;
  for (const t of this.layers.targets) {
    const p = this.llToScreen(t.lat, t.lng);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (best) return best;
  // grave dots are tappable too, but only while they're drawn (zoomed in)
  if (this.scale > 0.7) {
    let bd = 12;
    for (const g of this.layers.graves) {
      const p = this.llToScreen(g.lat, g.lng);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = g; }
    }
  }
  return best;
};

window.MapView = MapView;
})();
