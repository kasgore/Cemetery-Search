/* ==========================================================
   Cemetery Search — canvas map renderer (layer-based).
   World space: meters east/north of a fixed datum (home point),
   so any number of cemeteries render on one canvas. Screen: px, y down.
   Layers are plain lat/lng lists prepared by the UI layer:
   { lots:[{lat,lng,label}], blocks:[{lat,lng,label}], roads:[{lat,lng}],
     sections:[{lat,lng,label}], cems:[{lat,lng,label}], targets:[...] }
   ========================================================== */
(function () {
'use strict';

// low enough to fit the whole multi-cemetery region on a phone canvas
const MIN_SCALE = 0.002;

function MapView(canvas, proj, opts) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.proj = proj;                 // global projection (home-anchored)
  this.opts = opts || {};
  this.scale = 1.4;                 // px per meter
  this.cx = 0; this.cy = 0;         // world center (m east/north of datum)
  this.user = null;                 // {lat,lng,acc}
  this.layers = { lots: [], blocks: [], roads: [], sections: [], cems: [], targets: [] };
  this.highlight = null;            // {lat,lng,acc}
  this._pointers = new Map();
  this._lastPinch = null;
  this._bindings();
  this.resize();
}

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

  const s = this.scale;
  const L = this.layers;
  const inView = p => p.x > -25 && p.y > -25 && p.x < w + 25 && p.y < h + 25;

  // lot grid
  if (s > 0.55 && L.lots.length) {
    const showNums = s > 3.4;
    ctx.font = '9px JetBrains Mono, monospace';
    for (const pt of L.lots) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      ctx.fillStyle = 'rgba(148,138,118,0.75)';
      ctx.fillRect(p.x - 1.2, p.y - 1.2, 2.4, 2.4);
      if (showNums && pt.label) {
        ctx.fillStyle = 'rgba(80,72,58,0.85)';
        ctx.fillText(pt.label, p.x + 3, p.y + 3);
      }
    }
  }
  // roads
  if (s > 0.7) {
    ctx.fillStyle = 'rgba(110,101,87,0.5)';
    ctx.font = '9px JetBrains Mono, monospace';
    for (const pt of L.roads) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (inView(p)) ctx.fillText('· road ·', p.x - 16, p.y);
    }
  }
  // block letters
  if (s > 0.8) {
    ctx.fillStyle = 'rgba(74,93,58,0.8)';
    ctx.font = 'bold ' + Math.min(15, Math.max(10, s * 4)) + 'px JetBrains Mono, monospace';
    for (const pt of L.blocks) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (inView(p)) ctx.fillText(pt.label, p.x, p.y);
    }
  }
  // section names
  ctx.font = 'italic 600 ' + Math.min(17, Math.max(11, s * 9)) + 'px Cormorant Garamond, serif';
  ctx.fillStyle = 'rgba(44,58,36,0.55)';
  if (s > 0.5) {
    for (const pt of L.sections) {
      const p = this.llToScreen(pt.lat, pt.lng);
      if (!inView(p)) continue;
      const tw = ctx.measureText(pt.label).width;
      ctx.fillText(pt.label, p.x - tw / 2, p.y);
    }
  }
  // cemetery names (visible when zoomed out)
  ctx.font = 'italic 700 15px Cormorant Garamond, serif';
  ctx.fillStyle = 'rgba(20,24,15,0.8)';
  for (const pt of L.cems) {
    const p = this.llToScreen(pt.lat, pt.lng);
    if (p.x < -150 || p.y < -30 || p.x > w + 150 || p.y > h + 30) continue;
    const tw = ctx.measureText(pt.label).width;
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
      this.draw();
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
  this.draw();
};

MapView.prototype.hitTest = function (x, y, radius) {
  let best = null, bestD = radius || 18;
  for (const t of this.layers.targets) {
    const p = this.llToScreen(t.lat, t.lng);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
};

window.MapView = MapView;
})();
