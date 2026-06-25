#!/usr/bin/env python3
"""
Build the candidate dataset for the bridge-elevation review app.

For every OSM bridge in dem/vector/sampa-viario.gpkg (tunnels excluded), find the
GeoSampa `ponto_intervia` survey spot-heights near the deck CENTER and emit a
review record: deck geometry, center, the candidate survey points (so a human can
pick the on-deck one vs an under-street one), and terrain (sampa_geral.tif) / COP30 context.

Output: candidates.js  ->  window.CANDIDATES = [ ... ]   (loaded by index.html;
a plain <script src> works under file://, no local web server needed).

Reproducible — reads everything from the repo. Requires GDAL CLI (ogr2ogr,
gdallocationinfo) on $PATH. COP30 is optional context (set COP30_TIF or drop a
tile next to this script); terrain gap is the load-bearing signal.

    python3 build_candidates.py
"""
import csv, re, math, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.abspath(os.path.join(HERE, "..", ".."))       # sampasimu repo root
GPKG_BRIDGES = os.path.join(BASE, "dem", "vector", "sampa-viario.gpkg")
GPKG_SURVEY  = os.path.join(BASE, "downloads", "ponto_intervia.gpkg")
TERRAIN_TIF   = os.path.join(BASE, "dem", "sampa_geral.tif")
COP30_TIF    = os.environ.get("COP30_TIF", os.path.join(HERE, "cop30_S24_W047.tif"))

# A bridge qualifies for review if a survey point lies within this of its center.
CENTER_QUALIFY_M = 50.0
# Survey points offered to the reviewer as ele sources (pick deck vs under-street).
PICK_RADIUS_M    = 110.0

LAT0 = -23.55
MLON = 111320 * math.cos(math.radians(LAT0))
MLAT = 110900.0
def md(lon1, lat1, lon2, lat2):
    return math.hypot((lon2 - lon1) * MLON, (lat2 - lat1) * MLAT)

def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)

def export_csv(gpkg, layer, select, where, out):
    cmd = ["ogr2ogr", "-f", "CSV", out, gpkg, layer,
           "-t_srs", "EPSG:4326", "-lco", "GEOMETRY=AS_WKT", "-select", select]
    if where:
        cmd += ["-where", where]
    run(cmd)

def get_tag(ot, k):
    m = re.search(r'"%s"=>"([^"]*)"' % re.escape(k), ot or "")
    return m.group(1) if m else None

_WKT_PREFIX = ("POINT", "LINESTRING", "MULTILINESTRING", "MULTIPOINT")
def wkt_of(row):
    """The WKT string in a CSV row — GDAL names the column WKT or after the
    source geometry field (e.g. 'geom'), so locate it by value, not name."""
    for v in row.values():
        if v and v.lstrip().upper().startswith(_WKT_PREFIX):
            return v
    return ""

def parse_ls(wkt):
    m = re.search(r'\(([^()]*)\)', wkt or "")
    if not m:
        return None
    pts = []
    for pair in m.group(1).split(","):
        xy = pair.strip().split()
        if len(xy) >= 2:
            pts.append((float(xy[0]), float(xy[1])))  # lon, lat
    return pts if len(pts) >= 2 else None

def arclen_center(pts):
    seg = [md(pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1]) for i in range(len(pts)-1)]
    total = sum(seg); half = total / 2; acc = 0
    for i, s in enumerate(seg):
        if acc + s >= half:
            t = (half - acc) / s if s > 0 else 0
            return (pts[i][0] + (pts[i+1][0]-pts[i][0]) * t,
                    pts[i][1] + (pts[i+1][1]-pts[i][1]) * t), total
        acc += s
    return pts[len(pts)//2], total

def sample_raster(tif, lonlats):
    """gdallocationinfo batch; returns list of float|None aligned to input."""
    if not tif or not os.path.exists(tif) or not lonlats:
        return [None] * len(lonlats)
    inp = "\n".join("%.8f %.8f" % (lo, la) for lo, la in lonlats)
    p = subprocess.run(["gdallocationinfo", "-valonly", "-wgs84", tif],
                       input=inp, capture_output=True, text=True)
    out = []
    for x in p.stdout.splitlines():
        try:
            v = float(x); out.append(round(v, 2) if v > 5 else None)
        except ValueError:
            out.append(None)
    while len(out) < len(lonlats):
        out.append(None)
    return out[:len(lonlats)]

def main():
    for f in (GPKG_BRIDGES, GPKG_SURVEY, TERRAIN_TIF):
        if not os.path.exists(f):
            sys.exit("missing input: " + f)
    csv.field_size_limit(10**7)
    tmp = tempfile.mkdtemp(prefix="bele_")
    bridges_csv = os.path.join(tmp, "bridges.csv")
    survey_csv  = os.path.join(tmp, "survey.csv")

    print("exporting bridges (WGS84)…", flush=True)
    export_csv(GPKG_BRIDGES, "viario", "osm_id,name,highway,other_tags",
               "other_tags LIKE '%\"bridge\"=>%' AND other_tags NOT LIKE '%\"bridge\"=>\"no\"%'",
               bridges_csv)
    print("exporting ponto_intervia (WGS84)…", flush=True)
    export_csv(GPKG_SURVEY, "ponto_intervia", "cd_altitude", "", survey_csv)

    # --- index survey points ---
    survey = []
    for row in csv.DictReader(open(survey_csv)):
        w = wkt_of(row)
        p = parse_ls(w)
        if p is None:  # WKT for POINT has no commas; handle separately
            m = re.search(r'POINT\s*\(([^)]*)\)', w)
            if not m:
                continue
            xy = m.group(1).split()
            if len(xy) < 2:
                continue
            lon, lat = float(xy[0]), float(xy[1])
        else:
            lon, lat = p[0]
        try:
            alt = float(row["cd_altitude"])
        except (KeyError, ValueError):
            continue
        survey.append((lon, lat, alt))
    print("survey points:", len(survey))

    CELL = 0.0025
    grid = {}
    for lon, lat, alt in survey:
        grid.setdefault((int(lon/CELL), int(lat/CELL)), []).append((lon, lat, alt))

    def near(lon, lat, radius_m, cells=2):
        ck = (int(lon/CELL), int(lat/CELL)); found = []
        for dx in range(-cells, cells+1):
            for dy in range(-cells, cells+1):
                for (slon, slat, alt) in grid.get((ck[0]+dx, ck[1]+dy), ()):
                    d = md(lon, lat, slon, slat)
                    if d <= radius_m:
                        found.append((d, slon, slat, alt))
        found.sort()
        return found

    # --- bridges ---
    cands = []; n_tun = 0; n_total = 0
    for row in csv.DictReader(open(bridges_csv)):
        ot = row.get("other_tags", "")
        if get_tag(ot, "tunnel") == "yes":
            n_tun += 1; continue
        pl = parse_ls(wkt_of(row))
        if not pl:
            continue
        n_total += 1
        (clon, clat), dlen = arclen_center(pl)
        picks = near(clon, clat, PICK_RADIUS_M)
        if not picks or picks[0][0] > CENTER_QUALIFY_M:
            continue
        layer = get_tag(ot, "layer")
        try: layer = int(layer)
        except (TypeError, ValueError): layer = None
        cands.append({
            "id": row.get("osm_id"),
            "name": row.get("name") or "",
            "hw": row.get("highway") or "",
            "layer": layer,
            "btype": get_tag(ot, "bridge"),
            "c": [round(clat, 6), round(clon, 6)],
            "deck": [[round(la, 6), round(lo, 6)] for lo, la in pl],
            "len": round(dlen, 1),
            "sv": [{"ll": [round(slat, 6), round(slon, 6)],
                    "alt": round(alt, 2), "d": round(d, 1)}
                   for (d, slon, slat, alt) in picks],
        })

    # --- DEM context at each center ---
    centers = [(c["c"][1], c["c"][0]) for c in cands]
    terr = sample_raster(TERRAIN_TIF, centers)
    cop = sample_raster(COP30_TIF, centers)
    for c, fb, cp in zip(cands, terr, cop):
        c["terr"] = fb
        c["cop"] = cp

    # sort: elevated / multi-level / ambiguous first (need the most human judgment)
    def alt_spread(c):
        a = [s["alt"] for s in c["sv"][:6]]
        return (max(a) - min(a)) if len(a) > 1 else 0.0
    def score(c):
        gap = (c["sv"][0]["alt"] - c["terr"]) if c["terr"] is not None else 0
        return -(abs(gap) + alt_spread(c) + (5 if (c["layer"] or 0) >= 1 else 0))
    cands.sort(key=score)

    out_js = os.path.join(HERE, "candidates.js")
    meta = {
        "generated_from": "sampa-viario.gpkg + ponto_intervia.gpkg",
        "center_qualify_m": CENTER_QUALIFY_M,
        "pick_radius_m": PICK_RADIUS_M,
        "n_bridges_total": n_total,
        "n_tunnels_excluded": n_tun,
        "n_candidates": len(cands),
        "cop30": bool(os.path.exists(COP30_TIF)),
    }
    with open(out_js, "w") as f:
        f.write("// generated by build_candidates.py — do not edit by hand\n")
        f.write("window.CANDIDATES_META = " + json.dumps(meta) + ";\n")
        f.write("window.CANDIDATES = " + json.dumps(cands, separators=(",", ":")) + ";\n")
    print(json.dumps(meta, indent=2))
    print("wrote", out_js, "(%.1f KB)" % (os.path.getsize(out_js)/1024))

if __name__ == "__main__":
    main()
