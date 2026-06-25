# Bridge elevation review — `ponto_intervia` → OSM

A self-contained, human-in-the-loop tool to **approve / rectify / reject** a
proposed `ele` (deck elevation) for each São Paulo bridge, sourced from GeoSampa's
`ponto_intervia` surveyed street spot-heights. The output is a validated dataset
you upload to OSM by hand.

## Why a review step

`ponto_intervia` is ~1 m accurate and, where a point lands on a viaduct deck, it
measures the **deck** — which the **terrain model** (`sampa_geral.tif`, a DTM) and
COP30 (a DSM) can't resolve (both read the ground/water 13–16 m below). But a
survey point near a bridge **center** can also be the road *underneath* an
overpass, giving a wrong, too-low value. Only a person
looking at imagery can tell the deck point from the under-street point. That call
is exactly what this tool captures.

Coverage is limited by design: of 7,005 bridges (tunnels excluded — and
`ponto_intervia` has no subsurface points anyway), **470** have a survey point
within 50 m of their center. The rest are outside the survey footprint (central
SP only) and need a different source.

## Run it

Just open `index.html` in a browser (double-click — no server needed; it loads
`candidates.js` via a plain `<script>` tag and Leaflet from a CDN). You need
internet for the satellite tiles.

```text
tools/bridge-ele-review/
  index.html          ← the app (open this)
  candidates.js       ← generated data (470 bridges)  — committed
  build_candidates.py ← regenerates candidates.js from the gpkgs
  README.md
```

Base layers: **Satélite (Esri)** (default), **OpenStreetMap**, and **Topografia
(rmsampa-v2)** (the colored relief tiles from `telhas.pedalhidrografi.co`, over
OSM streets). The rmsampa-v2 relief is also available as an overlay (to drape over
the satellite). The terrain context is good for judging whether a survey point
sits on an elevated deck.

### Workflow

For each bridge the app shows the deck (red line), its center (yellow dot), and
every nearby `ponto_intervia` point (circles, **warm = above the terrain model ⇒
likely the deck**, blue = ground level). On the satellite basemap:

1. Confirm the selected point (white ring) is **on the deck**, not the road below.
2. If the default (nearest) point is wrong, **click the right one** (or press
   `1`–`9`), or type a **manual** value.
3. **Approve** (`A`) or **Reject** (`R`). `N` jumps to the next pending one.

Bridges most needing judgment (multi-level, big altitude spread, elevated decks)
are sorted first. Decisions persist in the browser (`localStorage`); use
**💾 Decisões** to back them up / move machines, **📂 Importar** to restore.

Keyboard: `A` approve · `R` reject · `J`/`→` next · `K`/`←` prev · `N` next
pending · `1`–`9` pick survey point.

## Output

- **⬇ GeoJSON** (`bridge_ele_validated.geojson`) — one `Point` per approved
  bridge **at the deck center**, properties: `osm_id` (the way), `ele`,
  `ele_source` (`ponto_intervia`/`manual`), `source_dist_m`, `terrain`, `cop30`,
  `terrain_gap`, `note`. This is the validated dataset.
- **⬇ CSV** — same, flat, for spreadsheets.
- **💾 Decisões** — full decision log incl. rejects (for resuming).

## Getting it into OSM

The export is deliberately editor-agnostic. Two reasonable ways to apply each
record, keyed by `osm_id`:

- **`ele` on the bridge way** (simplest, unambiguous): in JOSM/iD, open the way
  and set `ele=<value>`. Use the GeoJSON as a reference layer (JOSM: *Open* the
  `.geojson`; iD: custom map data) so you see the point + value while editing.
- **a node at the center with `ele`**: matches "one point at the center", but a
  bare `ele` node is less conventional — prefer it being a vertex of the way.

> ⚠️ **This is an import.** Pushing surveyed third-party data to OSM is governed
> by the [OSM import guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines)
> (documentation + community discussion + a dedicated account) and requires the
> source license to be OSM-compatible. **Verify the GeoSampa `ponto_intervia`
> license/permission before uploading.** Manual, reviewed, small-batch edits like
> this are the right shape — but the license check is on you.

## Regenerating the data

```sh
python3 build_candidates.py            # reads ../../dem/vector/sampa-viario.gpkg
                                       #   + ../../downloads/ponto_intervia.gpkg
                                       #   + ../../dem/sampa_geral.tif (terrain/DTM)
```

Requires GDAL CLI (`ogr2ogr`, `gdallocationinfo`). COP30 is **optional** context
(the terrain gap is the load-bearing signal). To include it, drop the Copernicus
GLO-30 tile for SP next to the script as `cop30_S24_W047.tif` (or set
`COP30_TIF=…`); fetch it from the AWS open bucket:

```sh
curl -o cop30_S24_W047.tif \
  https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S24_00_W047_00_DEM/Copernicus_DSM_COG_10_S24_00_W047_00_DEM.tif
```

(Don't commit the 40 MB tile.) Tunables at the top of `build_candidates.py`:
`CENTER_QUALIFY_M` (50 m — how close a survey point must be to qualify a bridge)
and `PICK_RADIUS_M` (110 m — survey points offered as rectify options).
