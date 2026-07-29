"""
Cemetery Search — data refresher.

Discovers local cemeteries with open Find a Grave photo requests, pulls their
request lists and memorial indexes (plots, GPS anchors, photo flags), optionally
pulls BS&A municipal burial registers, and writes the app's cemetery-data.js.

Everything is cached under DATA_DIR with per-stage cadences, so runs are cheap:
requests refresh every run; memorial indexes only when stale; registers rarely.
"""
import http.cookiejar
import json
import math
import os
import random
import re
import sys
import tempfile
import time
import urllib.request
import urllib.error
from datetime import date

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# Lives at the repo root: the frontend files sit next to this script, so the
# default SITE_DIR is this directory itself (cemetery-data.js is written here).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
SITE_DIR = os.environ.get("SITE_DIR", BASE_DIR)

DEFAULT_CONFIG = {
    "home": {"lat": 43.4202995, "lng": -84.6136017},
    "radius_miles": 15,
    "counties": {  # Find a Grave county location ids to scan
        "1255": "Gratiot", "1263": "Isabella", "1285": "Montcalm", "1245": "Clinton",
        "1299": "Saginaw", "1282": "Midland", "1244": "Clare", "1280": "Mecosta",
    },
    "pinned": [1252],          # always included even with zero open requests
    "declination": -6.6,       # true = magnetic + declination (west is negative)
    "cadence": {
        "discovery_hours": 24,
        "requests_hours": 0,   # every run
        "memorials_days": 7,
        "registers_days": 60,
        "tiles_days": 365,
    },
    # aerial imagery basemap: USDA NAIP via the USGS ImageServer (public domain,
    # ~0.6 m/px). Tiles are cut server-side and cached in DATA_DIR/tiles.
    "tiles": {
        "enabled": True,
        "zooms": [15, 16, 17, 18, 19],
        "export_url": ("https://imagery.nationalmap.gov/arcgis/rest/services/"
                       "USGSNAIPImagery/ImageServer/exportImage"),
    },
    # BS&A municipal burial registers (public, sessionless deep links).
    # section_map "oakgrove" applies the Oak Grove code table; anything else keeps
    # numeric sections as "Section N" so they align with the generic plot parser.
    "registers": [
        {"cemetery_id": 1252, "uid": 2024, "max_key": 10500, "seed": "seed/roster-1252.json", "section_map": "oakgrove"},
        {"cemetery_id": 1506, "uid": 1205, "max_key": 12000, "seed": "seed/roster-1506.json"},  # Riverside, City of Alma
        # static: seed-only, no BS&A pulls (interment.net transcription 1211, April 2024)
        {"cemetery_id": 1775380, "static": True, "seed": "seed/roster-1775380.json"},  # Ithaca
        # static: Gratiot County Cemeteries Online (mfhn.com grid via migenweb mirror,
        # crawled 2026-07-27 by tools/build-gratiotdb-rosters.js); positions are
        # section-row-position walk records or register lot-grave codes
        {"cemetery_id": 1434, "static": True, "seed": "seed/roster-1434.json"},        # Pritchard
        {"cemetery_id": 1491, "static": True, "seed": "seed/roster-1491.json"},        # Riverdale
        {"cemetery_id": 445, "static": True, "seed": "seed/roster-445.json"},          # Elm Hall
        {"cemetery_id": 2257472, "static": True, "seed": "seed/roster-2257472.json"},  # French Seville
        {"cemetery_id": 2357025, "static": True, "seed": "seed/roster-2357025.json"},  # St. Patricks-Irishtown
        {"cemetery_id": 154, "static": True, "seed": "seed/roster-154.json"},          # Brady (Seville Twp)
        {"cemetery_id": 1747, "static": True, "seed": "seed/roster-1747.json"},        # Sibley-Welch
        # static: Chippewa Twp 1941 sexton records (isabella.migenweb.org);
        # as_of_year gates dateless name-matching to era-plausible burials
        {"cemetery_id": 159825, "static": True, "seed": "seed/roster-159825.json", "as_of_year": 1941},  # Chippewa Twp
        # static: Lee Twp walk-order transcription (midland.migenweb.org/lee.html)
        {"cemetery_id": 159973, "static": True, "seed": "seed/roster-159973.json"},    # Lee Twp
    ],
    # static plat-map geometry per cemetery (produced by tools/ pipeline)
    # walk-order row grids are NOT baked — app-core fits them live at model
    # build (CS.fitWalkRows), so field-saved GPS pins refit rows in real time
    "geometry": {
        "1252": "geometry/oakgrove.json",
        "1506": "geometry/riverside.json",
        # City of Ithaca's own cemetery-map spreadsheet, georeferenced
        # (tools/extract-ithaca-grid.py + build-ithaca-geometry.js)
        "1775380": "geometry/ithaca.json",
    },
    # who holds the burial book — the call to make when a grave can't be found.
    # Sources: Gratiot Co. Cemetery Listing 2025-03-24 (gratiotmi.com), city/township sites.
    "contacts": {
        "1252": "City of St. Louis — clerk Jamie Long (989)681-2137 x1050; cemetery line (989)261-1435",
        "1506": "City of Alma clerk (989)463-8336; sexton Jim Goodhall (989)463-8339",
        "1775380": "City of Ithaca — sexton Jeffery Glynn, City Hall (989)875-3200",
        "1711": "Coe Twp — clerk Riley Travis (989)763-8829; twp hall (989)828-5960 (mgmt unconfirmed)",
        "2249320": "Village of Breckenridge office (989)842-3109 (lots, burials, genealogy)",
        "620247": "New Haven Twp — sexton Candy Smith (989)584-3707",
        "1475": "Richland Twp clerk Laurie Darmody (989)268-5286, richlandclerkvburg@gmail.com",
        "1037999": "North Star Twp — Heidi Drowley (989)875-3352",
        "445": "Sumner Twp — Carlene McGill (989)463-4531",
        "1828": "Sumner Twp — Carlene McGill (989)463-4531",
        "1434": "Sumner Twp — Carlene McGill (989)463-4531",
        "666": "Hamilton Twp — sexton Jeremy McAllister (989)666-0206",
        "89": "Emerson Twp (Beebe = Emerson Twp Cemetery) — sexton Jeremy McAllister (989)666-0206",
        "1381": "Emerson Twp — sexton Jeremy McAllister (989)666-0206",
        "252": "Private — Chapel Gardens, 6798 W Monroe Rd, Alma (989)341-6850",
        "2257472": "Seville Twp — Jim Mulder (989)859-0617",
        "154": "Seville Twp — Jim Mulder (989)859-0617",
        "153": "North Star Twp — Heidi Drowley (989)875-3352",
        "2015": "Pine River Twp — Joseph Dickman (989)463-6468",
        "159825": "Chippewa Twp — clerk/sexton Fran Ash (989)772-2685; twp (989)773-3600",
        "940": "Lincoln Twp — clerk Danielle Willoughby (989)560-0064; twp hall (989)828-6967",
        "863": "Lafayette Twp — Corey Schaub (989)620-4354",
        "879": "Lakefield Twp — sexton (989)620-6839; clerk Mike Slodowski (989)643-7731",
    },
    "max_memorials_per_cemetery": 30000,
    "page_pause_ms": [350, 600],
}


def load_config():
    # deep-copy defaults so overrides never mutate DEFAULT_CONFIG's nested dicts
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    path = os.path.join(BASE_DIR, "config.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            # dict-valued settings merge over defaults (a partial "cadence" override
            # must not drop the other cadence keys)
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    # env overrides
    if os.environ.get("RADIUS_MILES"):
        cfg["radius_miles"] = float(os.environ["RADIUS_MILES"])
    return cfg


# ---------------------------------------------------------------- utilities

def log(msg):
    print(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg, flush=True)


def http_get(url, retries=3, timeout=30, opener=None, referer=None):
    last = None
    for attempt in range(retries):
        try:
            headers = {"User-Agent": UA, "Accept": "application/json,text/html"}
            if referer:
                headers["Referer"] = referer
            req = urllib.request.Request(url, headers=headers)
            open_fn = opener.open if opener else urllib.request.urlopen
            with open_fn(req, timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET failed after {retries} tries: {url} ({last})")


def cookie_opener():
    """BS&A's LoadContent endpoint requires the session cookies set by PropertyDetails."""
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def get_json(url, **kw):
    body = http_get(url, **kw).decode("utf-8", "replace")
    try:
        return json.loads(body)
    except ValueError as e:
        # FAG serves HTTP-200 HTML challenge/maintenance pages to scripted clients;
        # surface as RuntimeError so per-stage handlers catch it like any fetch failure
        raise RuntimeError(f"non-JSON response from {url}: {body[:80]!r}") from e


def pause(cfg):
    lo, hi = cfg["page_pause_ms"]
    time.sleep(random.uniform(lo / 1000, hi / 1000))


def miles(a_lat, a_lng, b_lat, b_lng):
    r = 3958.8
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return r * 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def state_path(*parts):
    p = os.path.join(DATA_DIR, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def read_state(name, default=None):
    p = os.path.join(DATA_DIR, name)
    if os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except (ValueError, OSError):
            pass
    return default


def write_state(name, obj):
    p = state_path(name)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, p)


# ---------------------------------------------------------------- discovery

def discover(cfg):
    """Scan configured counties; return cemeteries within radius with open requests."""
    home = cfg["home"]
    found = {}
    for county_id, county in cfg["counties"].items():
        page, total, fetched = 1, math.inf, 0
        while fetched < total:
            url = (f"https://www.findagrave.com/cemetery/search?"
                   f"locationId=county_{county_id}&ajax=true&limit=20&page={page}")
            d = get_json(url)
            total = d.get("total") or d.get("cemeteryCount") or 0
            got = d.get("cemeteries") or []
            for c in got:
                cid = c.get("cemeteryId")
                loc = c.get("location") or {}
                if cid in found or not loc.get("lat"):
                    continue
                found[cid] = {
                    "id": cid,
                    "name": c.get("name", ""),
                    "county": county,
                    "lat": loc["lat"], "lng": loc["lon"],
                    "interments": c.get("interments") or 0,
                    "photoRequests": c.get("photoRequests") or 0,
                    "locationName": c.get("locationName", ""),
                    "miles": round(miles(home["lat"], home["lng"], loc["lat"], loc["lon"]), 1),
                }
            fetched += len(got)
            page += 1
            if not got:
                break
            pause(cfg)
        log(f"discovery: {county} county scanned ({fetched} cemeteries)")
    if not found:
        raise RuntimeError("discovery returned zero cemeteries — keeping previous registry")
    radius = cfg["radius_miles"]
    pinned = set(cfg["pinned"])
    selected = [c for c in found.values()
                if c["id"] in pinned or (c["miles"] <= radius and c["photoRequests"] > 0)]
    selected.sort(key=lambda c: c["miles"])
    log(f"discovery: {len(selected)} cemeteries within {radius} mi with open requests")
    return selected


def merge_registry(cfg, previous, fresh):
    """Fresh discovery wins, but pinned cemeteries (and anything with cached data)
    never silently vanish because one county scan came back short."""
    by_id = {c["id"]: c for c in fresh}
    pinned = set(cfg["pinned"])
    for old in previous:
        if old["id"] in by_id:
            continue
        if old["id"] in pinned or read_state(f"cem/{old['id']}-requests.json"):
            by_id[old["id"]] = old
    out = list(by_id.values())
    out.sort(key=lambda c: c.get("miles") or 0)
    return out


# ---------------------------------------------------------------- FAG pulls

def pull_requests(cfg, cem_id, cem=None):
    url = (f"https://www.findagrave.com/photo-request/search/cemetery/{cem_id}"
           f"?ajax=true&skip=0&limit=1000")
    d = get_json(url)
    out = []
    for r in d.get("photoRequests") or []:
        has_gps = r.get("latLonMethod") == "memorial"
        # junk-pin filter: FAG default pins sit exactly on the cemetery centroid
        if has_gps and cem and r.get("latitude"):
            try:
                d_m = miles(cem["lat"], cem["lng"], float(r["latitude"]), float(r["longitude"])) * 1609.34
                if d_m < 5 or d_m > 800:
                    has_gps = False
            except (TypeError, ValueError):
                has_gps = False
        out.append({
            "prId": r.get("photoRequestId"),
            "mid": r.get("memorialId"),
            "fn": r.get("firstName") or "",
            "ln": r.get("lastName") or "",
            "name": r.get("memorialName") or f"{r.get('firstName', '')} {r.get('lastName', '')}".strip(),
            "by": r.get("birthYear"), "dy": r.get("deathYear"),
            "bd": r.get("birthDate") or "", "dd": r.get("deathDate") or "",
            "plot": r.get("longPlot") or "",
            "notes": r.get("notes") or "",
            "req": r.get("reqPublicName") or "",
            "created": r.get("dateCreated") or "",
            "lat": float(r["latitude"]) if has_gps and r.get("latitude") else None,
            "lng": float(r["longitude"]) if has_gps and r.get("longitude") else None,
            # hard-case triage signals
            "claimed": r.get("dateClaimed") or "",
            "problem": re.sub(r"\s+", " ", str(r.get("problemDetails") or r.get("problems") or "")).strip()[:140],
        })
    return [r for r in out if r["mid"]]


def pull_memorials(cfg, cem, previous_count=0):
    """Full memorial index for one cemetery -> compact rows."""
    cem_id = cem["id"]
    rows, skip, total = [], 0, math.inf
    max_total = 0
    while skip < total and len(rows) < cfg["max_memorials_per_cemetery"]:
        url = (f"https://www.findagrave.com/cemetery/{cem_id}/memorial-search"
               f"?ajax=true&limit=100&skip={skip}")
        d = get_json(url)
        total = d.get("total") or 0
        max_total = max(max_total, total)
        got = d.get("collection") or []
        for r in got:
            mid = r.get("memorialId")
            if not mid:
                continue
            lat = lng = None
            if r.get("latitude") is not None and r.get("longitude") is not None:
                try:
                    la, ln = float(r["latitude"]), float(r["longitude"])
                    d_m = miles(cem["lat"], cem["lng"], la, ln) * 1609.34
                    if 5 <= d_m <= 800:  # junk-pin filter (off-site or default-centroid pins)
                        lat, lng = round(la, 6), round(ln, 6)
                except (TypeError, ValueError):
                    pass
            flags = 0
            if r.get("intermentHasPhoto"):
                flags |= 1
            if r.get("photoRequest"):
                flags |= 2
            if r.get("isVeteran"):
                flags |= 4
            if r.get("personHasPhoto"):
                flags |= 8
            # family links (spouse + children names) — the strongest lead for
            # hard-to-find graves: relatives share lots even across surnames
            fam = []
            for nm in (r.get("Spouses") or []) + (r.get("Children") or []):
                if isinstance(nm, str) and nm.strip():
                    fam.append(re.sub(r"\s+", " ", nm).strip()[:40])
                if len(fam) >= 8:
                    break
            rows.append([
                mid,
                r.get("fullName") or "",
                r.get("maidenName") or "",
                r.get("birthYear") or 0,
                r.get("deathYear") or 0,
                re.sub(r"\s+", " ", (r.get("plot") or "")).strip(),
                lat, lng, flags,
                "|".join(fam),
            ])
        skip += 100
        if not got:
            break
        pause(cfg)
        if skip % 2000 == 0:
            log(f"  memorials {cem['name']}: {len(rows)}/{total}")
    # truncation guard: a mid-pull soft-block must not replace a good cache
    floor = max(max_total, previous_count) * 0.5
    if floor > 100 and len(rows) < floor:
        raise RuntimeError(f"memorial pull for {cem['name']} looks truncated "
                           f"({len(rows)} rows vs expected ~{max(max_total, previous_count)})")
    return rows


# ---------------------------------------------------------------- BS&A register

BSA_KEEP = ["Name", "Former Name", "Sex", "Birth Date", "Burial Date", "Death Date",
            "Veteran", "Notes", "User 3", "Buriel at Foot", "Buriel at head",
            "Plot Number", "Section", "Block", "Lot", "Plot", "Status"]
BSA_ROW_RE = re.compile(
    r'label-value-row-label">([^<]*)</div><div role="cell" class="label-value-row-value">([^<]*)<')
# BS&A section code -> (canonical section, sub). Code 25 is the unknown-plot bucket.
BSA_SECTION = {
    "01": ("Old Part", "1"), "02": ("Old Part", "2"), "03": ("Old Part", "3"),
    "04": ("Old Part", "4"), "05": ("Old Part", "5"), "06": ("Vault Hill", ""),
    "07": ("Oak Hill", ""), "09": ("Mausoleum", ""), "10": ("Round Hill", ""),
    "11": ("Square Hill", ""), "12": ("Hofstetter Hill", ""), "13": ("Cutler Hill", ""),
    "14": ("Single Grave", ""), "15": ("Morris Hill", ""), "16": ("Veteran Hill", ""),
    "17": ("North Hill", ""), "25": ("", ""),
}


def bsa_parse_record(html):
    rec, names = {}, []
    for label, raw in BSA_ROW_RE.findall(html):
        label = label.strip()
        value = re.sub(r"&nbsp;?", " ", raw).replace("&amp;", "&").replace("&#39;", "'").strip()
        if value == label:
            value = ""
        if not label:
            continue
        if label == "Name":
            names.append(value)
            rec.setdefault("Name", value)
            continue
        if label in BSA_KEEP:
            rec.setdefault(label, value)
    return rec


def pull_register(cfg, reg):
    """Resumable pull of one BS&A cemetery register -> roster rows."""
    uid, max_key = reg["uid"], reg.get("max_key", 10500)
    cache = f"bsa/{uid}.jsonl"
    done = {}
    p = os.path.join(DATA_DIR, cache)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rec = json.loads(line)
                        done[rec["key"]] = rec
                    except ValueError:
                        pass
    # New burials get keys just past the last real record. Drop cached misses in the
    # tail band so each register cycle re-probes it instead of freezing forever.
    real_keys = [k for k, r in done.items() if not r.get("miss")]
    last_real = max(real_keys) if real_keys else 0
    for k in [k for k, r in done.items() if r.get("miss") and k > last_real]:
        del done[k]
    todo = [k for k in range(1, max_key + 1) if k not in done]
    if todo:
        log(f"register uid={uid}: pulling {len(todo)} remaining keys")
    section_map = reg.get("section_map")
    consecutive_miss = 0
    with open(state_path(cache), "a", encoding="utf-8") as out:
        for k in todo:
            if consecutive_miss > 400:  # record space exhausted — stop (don't poison the cache)
                log(f"register uid={uid}: {consecutive_miss} consecutive misses at key {k} — record space ends")
                break
            try:
                pd_url = (f"https://www.bsaonline.com/SiteSearch/PropertyDetails?uid={uid}"
                          f"&RecordKey={k}&RecordKeyType=10&ReferenceKey={k}&ReferenceType=6"
                          f"&SearchFocus=Cemetery%20Management&SearchCategory=Name&SearchText=x&PageIndex=1")
                opener = cookie_opener()  # LoadContent 403s without the session cookies
                html1 = http_get(pd_url, opener=opener).decode("utf-8", "replace")
                m = re.search(r'LoadContent[^"\']*', html1)
                if not m:
                    rec = {"key": k, "miss": True}
                    consecutive_miss += 1
                else:
                    lc_url = "https://www.bsaonline.com/CemeterySearch/" + m.group(0).replace("&amp;", "&")
                    rec = bsa_parse_record(http_get(lc_url, opener=opener, referer=pd_url).decode("utf-8", "replace"))
                    rec["key"] = k
                    if not rec.get("Name") and not rec.get("Plot Number"):
                        rec["miss"] = True
                        consecutive_miss += 1
                    else:
                        consecutive_miss = 0
                out.write(json.dumps(rec) + "\n")
                done[k] = rec
                time.sleep(random.uniform(0.15, 0.3))
            except RuntimeError as e:
                log(f"register uid={uid} key={k}: {e}")
                time.sleep(5)
    return register_rows(done, section_map)


def register_rows(done, section_map=None):
    rows = []
    for k in sorted(done):
        r = done[k]
        if r.get("miss") or not r.get("Name"):
            continue
        raw_section = (r.get("Section") or "").strip()
        if section_map == "oakgrove":
            section, sub = BSA_SECTION.get(raw_section, (raw_section, ""))
        else:
            section = ("Section " + raw_section.lstrip("0")) if raw_section.isdigit() and raw_section.lstrip("0") else raw_section
            sub = ""
        flags = 4 if (r.get("Veteran") or "").lower().startswith("y") else 0
        note_bits = [r.get("User 3") or "", r.get("Notes") or ""]
        if r.get("Buriel at head"):
            note_bits.append("head: " + r["Buriel at head"])
        if r.get("Buriel at Foot"):
            note_bits.append("foot: " + r["Buriel at Foot"])
        if r.get("Funeral Home"):
            # funeral homes keep their own burial records — a real lead for lost graves
            note_bits.append("funeral home: " + r["Funeral Home"])
        note = re.sub(r"\s+", " ", " | ".join(b for b in note_bits if b)).strip()[:160]
        block = (r.get("Block") or "").strip().upper()
        block = re.sub(r"^(?:BLOCK|BLCK|BLK)\s*", "", block)  # Alma writes "BLCKT" for block T
        rows.append([
            r["key"], (r.get("Name") or "").strip(), (r.get("Sex") or "").strip(),
            (r.get("Birth Date") or "").strip(), (r.get("Death Date") or "").strip(),
            (r.get("Burial Date") or "").strip(),
            section, sub,
            block,
            re.sub(r"^0+(?=\d)", "", (r.get("Lot") or "").strip()),
            re.sub(r"^0+(?=\d)", "", (r.get("Plot") or "").strip()),
            (r.get("Status") or "").strip(),
            flags, note, (r.get("Former Name") or "").strip(),
        ])
    return rows


# ---------------------------------------------------------------- imagery tiles

MERC_R = 6378137.0
MERC_HALF = math.pi * MERC_R


def ll_to_tile(z, lat, lng):
    n = 2 ** z
    x = int((lng + 180.0) / 360.0 * n)
    lat_r = math.radians(lat)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def tile_merc_bbox(z, x, y):
    n = 2 ** z
    size = 2 * MERC_HALF / n
    xmin = -MERC_HALF + x * size
    ymax = MERC_HALF - y * size
    return xmin, ymax - size, xmin + size, ymax


def tile_path(z, x, y):
    return os.path.join(DATA_DIR, "tiles", str(z), str(x), f"{y}.img")


def fetch_tile(cfg, z, x, y):
    """Fetch one 256px tile from the NAIP ImageServer and cache it. Returns path or None."""
    p = tile_path(z, x, y)
    if os.path.exists(p):
        return p
    xmin, ymin, xmax, ymax = tile_merc_bbox(z, x, y)
    url = (f"{cfg['tiles']['export_url']}?bbox={xmin},{ymin},{xmax},{ymax}"
           f"&bboxSR=3857&imageSR=3857&size=256,256&format=jpgpng&f=image")
    body = http_get(url)
    if len(body) < 500 or body[:1] == b"<":  # error page, not an image
        raise RuntimeError(f"tile {z}/{x}/{y}: non-image response ({len(body)}B)")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(body)
    os.replace(tmp, p)
    return p


def pull_tiles(cfg, registry):
    """Prefetch the imagery pyramid around every cemetery (one-time; cached forever)."""
    total_new = errors = 0
    for cem in registry["cemeteries"]:
        # bigger cemeteries get a wider imagery box
        radius = min(650.0, max(300.0, 250.0 + math.sqrt(max(cem.get("interments", 0), 1)) * 6.0))
        dlat = radius / 110540.0
        dlng = radius / (111320.0 * math.cos(math.radians(cem["lat"])))
        new_here = 0
        for z in cfg["tiles"]["zooms"]:
            x0, y0 = ll_to_tile(z, cem["lat"] + dlat, cem["lng"] - dlng)
            x1, y1 = ll_to_tile(z, cem["lat"] - dlat, cem["lng"] + dlng)
            for x in range(min(x0, x1), max(x0, x1) + 1):
                for y in range(min(y0, y1), max(y0, y1) + 1):
                    if os.path.exists(tile_path(z, x, y)):
                        continue
                    try:
                        fetch_tile(cfg, z, x, y)
                        new_here += 1
                        time.sleep(0.08)
                    except RuntimeError as e:
                        errors += 1
                        if errors > 200:
                            log(f"tiles: too many errors, stopping this cycle ({e})")
                            return total_new
        if new_here:
            log(f"tiles: {cem['name']} +{new_here}")
        total_new += new_here
    log(f"tiles: {total_new} new tiles cached ({errors} errors)")
    return total_new


# ---------------------------------------------------------------- build

def build_output(cfg, registry):
    # cemetery grounds from OpenStreetMap (boundaries/drives/gates),
    # baked by tools/pull-osm-grounds.js — optional, static
    osm_grounds = {}
    osm_path = os.path.join(BASE_DIR, "geometry", "osm-grounds.json")
    if os.path.exists(osm_path):
        with open(osm_path, encoding="utf-8") as f:
            osm_grounds = json.load(f)
    cemeteries = []
    for cem in registry["cemeteries"]:
        cid = str(cem["id"])
        requests = read_state(f"cem/{cid}-requests.json", [])
        memorials = read_state(f"cem/{cid}-memorials.json", [])
        entry = {
            "id": cem["id"], "name": cem["name"], "county": cem["county"],
            "lat": cem["lat"], "lng": cem["lng"], "miles": cem["miles"],
            "declination": cfg["declination"],
            "contact": cfg.get("contacts", {}).get(cid, ""),
            "meta": {
                "asOf": registry.get("requestsAsOf", ""),
                "memorialsAsOf": registry.get("memorialsAsOf", {}).get(cid, ""),
                "interments": cem.get("interments", 0),
            },
            "requests": requests,
            "memorials": memorials,
        }
        if cid in osm_grounds:
            entry["grounds"] = osm_grounds[cid]
        geom_file = cfg["geometry"].get(cid)
        if geom_file:
            with open(os.path.join(BASE_DIR, geom_file), encoding="utf-8") as f:
                geom = json.load(f)
            entry["sections"] = geom.get("sections") or {}
            entry["maps"] = geom.get("maps") or []
            if geom.get("sgBlocks"):
                entry["sgBlocks"] = geom["sgBlocks"]
        for reg in cfg["registers"]:
            if reg["cemetery_id"] == cem["id"]:
                roster = read_state(f"cem/{cid}-roster.json", [])
                if roster:
                    entry["roster"] = roster
                    if reg.get("uid"):
                        entry["bsaUid"] = reg["uid"]
                    if reg.get("as_of_year"):
                        entry["rosterAsOf"] = reg["as_of_year"]
        cemeteries.append(entry)

    payload = {
        "v": 2,
        "generated": date.today().isoformat(),
        "home": cfg["home"],
        "radiusMiles": cfg["radius_miles"],
        "cemeteries": cemeteries,
    }
    js = ("// Cemetery Search dataset — generated " + payload["generated"] +
          " by the refresher service\n" +
          "window.CEMDATA = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    out_path = os.path.join(SITE_DIR, "cemetery-data.js")
    os.makedirs(SITE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=SITE_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(js)
    os.replace(tmp, out_path)
    total_req = sum(len(c["requests"]) for c in cemeteries)
    total_mem = sum(len(c["memorials"]) for c in cemeteries)
    log(f"wrote cemetery-data.js: {len(cemeteries)} cemeteries, "
        f"{total_req} requests, {total_mem} memorials, {len(js) // 1024} KB")
    write_state("status.json", {
        "generated": payload["generated"],
        "ts": time.time(),
        "cemeteries": len(cemeteries),
        "requests": total_req,
        "memorials": total_mem,
    })


# ---------------------------------------------------------------- main cycle

def seed_register_cache(cfg):
    """Copy repo-shipped register seeds into the state dir on first run."""
    for reg in cfg["registers"]:
        seed = reg.get("seed")
        cid = str(reg["cemetery_id"])
        roster_state = f"cem/{cid}-roster.json"
        if seed and not read_state(roster_state):
            seed_path = os.path.join(BASE_DIR, seed)
            if os.path.exists(seed_path):
                with open(seed_path, encoding="utf-8") as f:
                    write_state(roster_state, json.load(f))
                log(f"seeded register for cemetery {cid} from {seed}")


def seed_from_baked(registry, ts, now):
    """First boot with an empty volume: seed per-cemetery caches from the baked
    cemetery-data.js so we don't re-crawl ~67k memorials we already ship."""
    if registry.get("seededFromBaked"):
        return
    baked = os.path.join(SITE_DIR, "cemetery-data.js")
    if not os.path.exists(baked):
        registry["seededFromBaked"] = True
        return
    try:
        with open(baked, encoding="utf-8") as f:
            raw = f.read()
        data = json.loads(raw[raw.index("{"):raw.rindex(";")])
    except (ValueError, OSError) as e:
        log(f"could not seed from baked dataset: {e}")
        registry["seededFromBaked"] = True
        return
    seeded = 0
    for cem in data.get("cemeteries", []):
        cid = str(cem.get("id"))
        if cem.get("memorials") and not read_state(f"cem/{cid}-memorials.json"):
            write_state(f"cem/{cid}-memorials.json", cem["memorials"])
            ts[f"mem_{cid}"] = now
            registry.setdefault("memorialsAsOf", {})[cid] = data.get("generated", "")
            seeded += 1
        if cem.get("requests") and not read_state(f"cem/{cid}-requests.json"):
            write_state(f"cem/{cid}-requests.json", cem["requests"])
        if cem.get("roster") and not read_state(f"cem/{cid}-roster.json"):
            write_state(f"cem/{cid}-roster.json", cem["roster"])
    if seeded:
        log(f"seeded caches for {seeded} cemeteries from the baked dataset")
    registry["seededFromBaked"] = True


def run_cycle(cfg, force=False):
    now = time.time()
    cadence = cfg["cadence"]
    registry = read_state("registry.json", {"cemeteries": [], "ts": {}, "memorialsAsOf": {}})
    ts = registry.setdefault("ts", {})

    seed_register_cache(cfg)
    seed_from_baked(registry, ts, now)

    # 1. discovery
    if force or now - ts.get("discovery", 0) > cadence["discovery_hours"] * 3600:
        try:
            registry["cemeteries"] = merge_registry(cfg, registry.get("cemeteries", []), discover(cfg))
            ts["discovery"] = now
        except RuntimeError as e:
            log(f"discovery failed (keeping previous registry): {e}")

    # 2. photo requests — every run, cheap (1 call per cemetery)
    if force or now - ts.get("requests", 0) > cadence["requests_hours"] * 3600:
        for cem in registry["cemeteries"]:
            try:
                reqs = pull_requests(cfg, cem["id"], cem)
                write_state(f"cem/{cem['id']}-requests.json", reqs)
                cem["photoRequests"] = len(reqs)
                pause(cfg)
            except RuntimeError as e:
                log(f"requests pull failed for {cem['name']}: {e}")
        ts["requests"] = now
        registry["requestsAsOf"] = date.today().isoformat()

    # 3. memorial indexes — when stale or missing
    mem_as_of = registry.setdefault("memorialsAsOf", {})
    for cem in registry["cemeteries"]:
        cid = str(cem["id"])
        have = read_state(f"cem/{cid}-memorials.json")
        stale = now - ts.get(f"mem_{cid}", 0) > cadence["memorials_days"] * 86400
        if have is None or stale or force:
            try:
                log(f"pulling memorial index: {cem['name']} (~{cem.get('interments', '?')} burials)")
                rows = pull_memorials(cfg, cem, previous_count=len(have) if have else 0)
                if rows:
                    write_state(f"cem/{cid}-memorials.json", rows)
                    ts[f"mem_{cid}"] = now
                    mem_as_of[cid] = date.today().isoformat()
            except RuntimeError as e:
                log(f"memorial pull failed for {cem['name']}: {e}")

    # 4. BS&A registers — rarely (a repo-shipped seed counts as fresh on first run)
    for reg in cfg["registers"]:
        if reg.get("static"):
            continue  # seed-only source (e.g. interment.net transcription) — nothing to pull
        cid = str(reg["cemetery_id"])
        key = f"reg_{reg['uid']}"
        if key not in ts and read_state(f"cem/{cid}-roster.json"):
            ts[key] = now
            continue
        if force or now - ts.get(key, 0) > cadence["registers_days"] * 86400:
            try:
                rows = pull_register(cfg, reg)
                if rows:
                    write_state(f"cem/{cid}-roster.json", rows)
                ts[key] = now
            except RuntimeError as e:
                log(f"register pull failed uid={reg['uid']}: {e}")

    # 5. aerial imagery tiles — incremental every cycle (already-cached tiles cost
    # nothing to skip, and newly discovered cemeteries get their imagery next run)
    if cfg.get("tiles", {}).get("enabled"):
        try:
            pull_tiles(cfg, registry)
        except RuntimeError as e:
            log(f"tile prefetch failed (will retry next cycle): {e}")

    write_state("registry.json", registry)
    build_output(cfg, registry)


if __name__ == "__main__":
    run_cycle(load_config(), force="--force" in sys.argv)
