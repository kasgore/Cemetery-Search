"""
Cemetery Search — Flask server. Run from this directory:

    python app.py            # serves the app on http://localhost:8420/

Serves the frontend and keeps its data fresh automatically: a background
thread runs the refresher on a schedule (REFRESH_HOURS, default 6). On first
boot with no data it populates itself (discovery -> pulls -> build).

Env knobs: PORT (8420), REFRESH_HOURS (6), RADIUS_MILES (15),
AUTO_REFRESH=0 to disable self-updating, DATA_DIR, SITE_DIR.
"""
import os
import threading

from flask import Flask, jsonify, send_from_directory

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
_state = {"refreshing": False, "last_error": None, "wake": threading.Event()}


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
        _state["wake"].wait(timeout=REFRESH_HOURS * 3600)


def start_background_refresher():
    if os.environ.get("AUTO_REFRESH", "1").lower() in ("0", "false", "no"):
        refresher.log("auto-refresh disabled (AUTO_REFRESH=0)")
        return
    t = threading.Thread(target=_loop, daemon=True, name="refresher")
    t.start()


start_background_refresher()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8420"))
    try:
        from waitress import serve
        refresher.log(f"serving on http://0.0.0.0:{port}/ (waitress)")
        serve(app, host="0.0.0.0", port=port)
    except ImportError:
        refresher.log(f"serving on http://0.0.0.0:{port}/ (flask dev server — pip install waitress for production)")
        app.run(host="0.0.0.0", port=port)
