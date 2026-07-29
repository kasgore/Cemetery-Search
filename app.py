"""
Cemetery Search — Flask server. Run from this directory:

    python app.py            # serves the app on http://localhost:8420/

Serves the frontend and keeps its data fresh automatically: a background
thread runs the refresher on a schedule (REFRESH_HOURS, default 6). On first
boot with no data it populates itself (discovery -> pulls -> build).

Env knobs: PORT (8420), HTTPS_PORT (unset = HTTP only; the container sets
80/443), CERT_HOSTS (SANs for the auto-generated self-signed cert),
REFRESH_HOURS (6), RADIUS_MILES (15), AUTO_REFRESH=0 to disable
self-updating, DATA_DIR, SITE_DIR.
"""
import os
import re
import ssl
import subprocess
import threading

from flask import Flask, jsonify, request, send_from_directory

import refresher

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SITE_DIR = os.environ.get("SITE_DIR", BASE_DIR)
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
REFRESH_HOURS = float(os.environ.get("REFRESH_HOURS", "6"))

# Only the app's own assets are served — never the server code, seeds,
# caches, or the git tree that share this directory.
ALLOWED_FILES = {
    "index.html", "cemetery-search.html",
    "app-core.js", "app-map.js", "app-ui.js",
    "cemetery-data.js", "xlsx.full.min.js",
    "sw.js", "manifest.webmanifest",
}
ALLOWED_DIRS = {"icons"}
NEVER_CACHE = {"index.html", "cemetery-data.js", "sw.js"}

app = Flask(__name__)
_state = {"refreshing": False, "last_error": None, "wake": threading.Event(), "urls": []}


@app.get("/")
def index():
    return send_from_directory(SITE_DIR, "index.html", max_age=0)


@app.get("/<path:path>")
def static_files(path):
    parts = path.split("/")
    ok = (len(parts) == 1 and parts[0] in ALLOWED_FILES) or \
         (len(parts) == 2 and parts[0] in ALLOWED_DIRS)
    if not ok:
        return jsonify({"error": "not found"}), 404
    max_age = 0 if path in NEVER_CACHE else 3600
    return send_from_directory(SITE_DIR, path, max_age=max_age)


@app.get("/tiles/<int:z>/<int:x>/<int:y>.jpg")
def tile(z, x, y):
    """Aerial imagery tiles (NAIP, public domain). Served from the local cache;
    missing tiles are fetched once on demand so panning beyond the prefetched
    area still works while online."""
    if not (10 <= z <= 20) or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        return jsonify({"error": "bad tile"}), 404
    path = refresher.tile_path(z, x, y)
    if not os.path.exists(path):
        try:
            refresher.fetch_tile(refresher.load_config(), z, x, y)
        except Exception:
            return jsonify({"error": "tile unavailable"}), 404
    with open(path, "rb") as f:
        magic = f.read(3)
    mime = "image/png" if magic.startswith(b"\x89P") else "image/jpeg"
    resp = send_from_directory(os.path.dirname(path), os.path.basename(path), max_age=30 * 86400)
    resp.mimetype = mime
    return resp


@app.get("/api/status")
def status():
    st = refresher.read_state("status.json", {}) or {}
    st["refreshing"] = _state["refreshing"]
    st["lastError"] = _state["last_error"]
    st["refreshHours"] = REFRESH_HOURS
    return jsonify(st)


@app.post("/api/refresh")
def trigger_refresh():
    if _state["refreshing"]:
        return jsonify({"ok": False, "reason": "already refreshing"}), 409
    _state["wake"].set()
    return jsonify({"ok": True})


# Field-log backup: the browser's progress store (finds, notes, saved GPS
# pins) syncs here so a lost phone or evicted browser cache never loses a
# find. Per-grave newest-timestamp merge — two devices can both contribute.
@app.get("/api/progress")
def get_progress():
    return jsonify({"progress": refresher.read_state("progress-backup.json", {}) or {}})


@app.post("/api/progress")
def post_progress():
    body = request.get_json(silent=True) or {}
    incoming = body.get("progress")
    if not isinstance(incoming, dict):
        return jsonify({"ok": False, "reason": "no progress object"}), 400
    stored = refresher.read_state("progress-backup.json", {}) or {}
    for pk, v in incoming.items():
        if not isinstance(v, dict):
            continue
        old = stored.get(pk)
        if not old or (v.get("ts") or 0) >= (old.get("ts") or 0):
            stored[pk] = v
    refresher.write_state("progress-backup.json", stored)
    return jsonify({"ok": True, "progress": stored})


# Field photos: reference copies of stone photos, keyed by the same pk as
# progress ("<memorialId>" or "ros:<key>"). Stored in the data volume, so
# they survive image rebuilds like everything else.
def _photo_path(pk, thumb=False):
    # pk is "<memorialId>" or "ros:<key>", optionally with a photo slot
    # suffix "#<n>" so one grave can hold several shots (stone, context,
    # inscription detail — all useful to the family)
    slot = ""
    if "#" in pk:
        pk, _, slot = pk.partition("#")
        if not re.fullmatch(r"\d{1,3}", slot):
            return None
        slot = "" if slot == "0" else "-" + slot
    if not re.fullmatch(r"\d+|ros:\w+", pk):
        return None
    d = os.path.join(DATA_DIR, "photos")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, pk.replace(":", "_") + slot + (".thumb.jpg" if thumb else ".jpg"))


@app.get("/api/photos")
def list_photos():
    d = os.path.join(DATA_DIR, "photos")
    out = []
    if os.path.isdir(d):
        for f in os.listdir(d):
            if not f.endswith(".jpg") or f.endswith(".thumb.jpg"):
                continue
            st = os.stat(os.path.join(d, f))
            name = f[:-4]
            slot = 0
            m = re.search(r"-(\d{1,3})$", name)
            if m:
                name, slot = name[: m.start()], int(m.group(1))
            out.append({
                "pk": name.replace("ros_", "ros:", 1),
                "slot": slot,
                "ts": int(st.st_mtime * 1000),
                "size": st.st_size,
            })
    out.sort(key=lambda x: -x["ts"])
    return jsonify({"photos": out})


@app.get("/api/photo/<pk>")
def get_photo(pk):
    want_thumb = request.args.get("thumb") == "1"
    p = _photo_path(pk, thumb=want_thumb)
    if want_thumb and (not p or not os.path.exists(p)):
        p = _photo_path(pk)   # no thumb stored — fall back to the full image
    if not p or not os.path.exists(p):
        return jsonify({"error": "not found"}), 404
    return send_from_directory(os.path.dirname(p), os.path.basename(p), max_age=0)


@app.delete("/api/photo/<pk>")
def delete_photo(pk):
    removed = 0
    for thumb in (False, True):
        p = _photo_path(pk, thumb=thumb)
        if p and os.path.exists(p):
            os.remove(p)
            removed += 1
    return jsonify({"ok": True, "removed": removed})


@app.post("/api/photo/<pk>")
def put_photo(pk):
    p = _photo_path(pk, thumb=request.args.get("thumb") == "1")
    if not p:
        return jsonify({"error": "bad key"}), 400
    # full-resolution originals — modern phone JPEGs run 3-12 MB
    data = request.get_data(cache=False)
    if not data or len(data) > 25 * 1024 * 1024:
        return jsonify({"error": "empty or too large"}), 400
    if not data.startswith(b"\xff\xd8"):   # JPEG magic — the app only sends JPEG
        return jsonify({"error": "not a jpeg"}), 400
    with open(p, "wb") as f:
        f.write(data)
    return jsonify({"ok": True})


def _loop():
    while True:
        _state["refreshing"] = True
        try:
            cfg = refresher.load_config()  # re-read each cycle; a bad config.json must not kill the thread
            refresher.run_cycle(cfg)
            _state["last_error"] = None
        except Exception as e:  # keep serving even if a cycle dies
            _state["last_error"] = str(e)
            refresher.log(f"refresh cycle failed: {e}")
        _state["refreshing"] = False
        _state["wake"].clear()
        if _state["urls"]:  # re-announce after the cycle's log spew scrolls the startup line away
            refresher.log("app is listening at " + " and ".join(_state["urls"]))
        _state["wake"].wait(timeout=REFRESH_HOURS * 3600)


def start_background_refresher():
    if os.environ.get("AUTO_REFRESH", "1").lower() in ("0", "false", "no"):
        refresher.log("auto-refresh disabled (AUTO_REFRESH=0)")
        return
    t = threading.Thread(target=_loop, daemon=True, name="refresher")
    t.start()


start_background_refresher()


def ensure_self_signed_cert():
    """Generate a self-signed cert for the LAN address via the openssl CLI.
    Browsers warn on it; accepting the warning still gives a secure context,
    which is what unlocks phone GPS/compass over https. Regenerated whenever
    CERT_HOSTS changes."""
    tls_dir = os.path.join(DATA_DIR, "tls")
    cert, key = os.path.join(tls_dir, "cert.pem"), os.path.join(tls_dir, "key.pem")
    hosts_file = os.path.join(tls_dir, "hosts.txt")
    hosts_env = os.environ.get("CERT_HOSTS", "192.168.5.14,localhost")
    if os.path.exists(cert) and os.path.exists(key):
        try:
            with open(hosts_file, encoding="utf-8") as f:
                if f.read().strip() == hosts_env.strip():
                    return cert, key
        except OSError:
            pass  # no marker: regenerate with the current hosts
    os.makedirs(tls_dir, exist_ok=True)
    hosts = [h.strip() for h in hosts_env.split(",") if h.strip()]
    sans = []
    for h in hosts:
        parts = h.split(".")
        is_ip = len(parts) == 4 and all(p.isdigit() for p in parts)
        sans.append(("IP:" if is_ip else "DNS:") + h)
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "3650",
        "-subj", "/CN=Cemetery Search",
        "-addext", "subjectAltName=" + ",".join(sans),
    ], check=True, capture_output=True)
    with open(hosts_file, "w", encoding="utf-8") as f:
        f.write(hosts_env.strip())
    refresher.log(f"generated self-signed certificate for {', '.join(hosts)} in {tls_dir}")
    return cert, key


def serve_https(port):
    try:
        cert, key = ensure_self_signed_cert()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError) as e:
        refresher.log(f"HTTPS disabled — could not create certificate ({e})")
        return
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    from werkzeug.serving import run_simple
    refresher.log(f"serving on https://0.0.0.0:{port}/ (self-signed — accept the browser warning once per device)")
    run_simple("0.0.0.0", port, app, ssl_context=ctx, threaded=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8420"))
    https_port = os.environ.get("HTTPS_PORT")
    _state["urls"] = [f"http://localhost:{port}/"]
    if https_port:
        _state["urls"].append(f"https://localhost:{https_port}/")
        threading.Thread(target=serve_https, args=(int(https_port),), daemon=True, name="https").start()
    try:
        from waitress import serve
        refresher.log(f"serving on http://0.0.0.0:{port}/ (waitress)")
        serve(app, host="0.0.0.0", port=port)
    except ImportError:
        refresher.log(f"serving on http://0.0.0.0:{port}/ (flask dev server — pip install waitress for production)")
        app.run(host="0.0.0.0", port=port)
