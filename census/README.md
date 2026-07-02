# census/ — population-weighted reference sampling (IBGE Censo 2022)

Tooling that seeds simujoules reference points from the real population
distribution instead of uniform/random placement. The idea: reference "trips"
should originate where people actually live, so the density field over a DEM
approximates real cycling demand.

Two consumers share that idea, from the same IBGE inputs:

- **Live, in-browser ("census" sampling strategy).** `build_fgb.py` joins the
  national setor population onto the national geometry and writes a single
  cloud-hosted **FlatGeobuf** (`setores_br_pop.fgb`). The PWA's *Sampling
  strategy → "IBGE 2022 census"* option fetches only the setores inside the
  current DEM's bbox over **HTTP Range requests** and runs the same
  population-weighted Sobol sampler as `sample_census.py`, live. This is the
  path most users hit. → section **"Live cloud sampling"** below.
- **Offline precompute (a baked bundle).** `sample_census.py` →
  `census-density.mjs` samples points and runs the density engine ahead of time,
  producing an app-importable `simujoules-*.zip`. → sections 0–3 below.

Nothing here is shipped by `deploy.sh` (it stages an explicit file list, so
`census/` never reaches users, same as `backend/` and the `test-*.mjs` files).
The cloud FlatGeobuf is **not** in the app bundle either — it lives in the GCS
bucket and is uploaded by hand (below).

```
# live cloud path (most users):
download_census.py --national  →  build_fgb.py  →  gcloud upload  →  cloud .fgb
   (BR_setores gpkg + CSV)         (setores_br_pop.fgb)              (queried by bbox)

# offline precompute path (a fixed baked bundle):
download_census.py  →  sample_census.py  →  census-density.mjs
   (IBGE files)         (points.geojson)      (simujoules-*.zip)
```

## Live cloud sampling — `build_fgb.py` (+ upload)

Needs **GDAL ≥ 3.x** on `PATH` (`ogr2ogr`, `ogrinfo`) with the FlatGeobuf
driver — no geopandas/osgeo bindings required.

```sh
# 1. national geometry (~1.5 GB) + the national "basico" population CSV
python download_census.py --national

# 2. join pop (v0001) + simplify (~11 m) + reproject to EPSG:4326 + FlatGeobuf
python build_fgb.py            # -> setores_br_pop.fgb  (~450 MB, indexed)

# 3. upload (NOT via deploy.sh — the .fgb is cloud-only)
gcloud storage cp setores_br_pop.fgb \
  gs://simujaules/census/setores_br_pop.fgb \
  --content-type=application/octet-stream --cache-control="public, max-age=86400"
```

> **Do not refresh the old `gs://telhas/simujoules/census/` copy** — it's dead
> since the app moved to its own bucket; the app never reads it.

FlatGeobuf carries a packed Hilbert R-tree, so the browser fetches only the
bbox slice (a few hundred KB for a city), never the whole file — a raw `.gpkg`
**cannot** be range-queried over HTTP, which is why we convert. The app reads
the **direct GCS URL** (`storage.googleapis.com/simujaules/…`, native Range +
bucket CORS), set as `CENSUS_FGB_URL` in `app.js`. To repoint, change that
constant.

**CORS (one-time, bucket-level).** Cross-origin Range reads from the app origin
need the bucket to allow them and expose the range headers:

```sh
cat > cors.json <<'JSON'
[{ "maxAgeSeconds": 3600, "method": ["GET","HEAD"], "origin": ["*"],
   "responseHeader": ["Content-Type","Cache-Control","Content-Range","Content-Length","Accept-Ranges","ETag"] }]
JSON
gcloud storage buckets update gs://simujaules --cors-file=cors.json
```

Verify end-to-end before relying on it in the app (queries the SP city bbox):

```sh
curl -s -o /dev/null -D - -H "Range: bytes=0-7" \
  https://storage.googleapis.com/simujaules/census/setores_br_pop.fgb | grep -i 206   # 206 Partial Content
ogrinfo -spat -46.77 -23.60 -46.59 -23.48 setores_br_pop.fgb setores | head   # local sanity
node test-census-sampler.mjs                                                   # sampler math (mirrors app.js)
```

> `build_fgb.py` works on a (reflink) copy of the malha — the source download
> is never mutated — and drops the scratch pop table afterwards. The simplify
> tolerance (`--simplify`, default `0.0001°`) is conservative on purpose:
> aggressive values can push a sampled point across a real setor edge. Points
> are locality seeds, not survey-grade; the app still snaps each to a passable
> DEM cell.

## 0. Download the IBGE data — `download_census.py`

Stdlib only (no pip install). Pulls, into `census_data/`:

- **Malha de setores censitários 2022** (geometry, GeoPackage) for one UF.
- **Agregados por setor "básico"** (national zip → CSV). Total resident
  population is column **`v0001`** (confirm in the data dictionary, `--dict`).

```sh
python download_census.py --uf SP          # ~170 MB malha + national básico zip
python download_census.py --uf SP --dict   # also fetch the data dictionary
```

Both files are joined later on **`CD_SETOR`** (15-digit setor code; SP codes
start with `35`). The básico table is national — you filter to SP by the
spatial join in step 1, not by a per-state download.

If the básico URL 404s, IBGE bumped its date suffix — browse
`ftp.ibge.gov.br/.../Agregados_por_Setor_csv/` and pass the new file.

## 1. Sample reference points — `sample_census.py`

`pip install -r requirements.txt` (geopandas, shapely, scipy, pandas, numpy;
rasterio only if you use `--dem`). Then:

```sh
python sample_census.py \
  --malha census_data/SP_setores_CD2022.gpkg \
  --pop   census_data/Agregados_por_setores_basico_BR.csv \
  --dem   ../dem/sampa_geral.tif \
  -n 512 --seed 12345 \
  -o points.geojson
```

What it does:

1. Reads the DEM bbox + CRS from the GeoTIFF header (or pass `--bbox xmin ymin
   xmax ymax` to skip rasterio).
2. Reprojects the malha to the DEM CRS and keeps setores **intersecting** the
   bbox (fully or partially contained).
3. Joins population on `CD_SETOR`, clips each setor to the bbox, and weights it
   by population **inside the extent** (`pop × clipped/full area`).
4. Samples `N` points: a **Sobol** sequence picks setores via the
   population-weighted inverse CDF, and a per-setor **Sobol** stream places each
   point uniformly inside the polygon (bbox draw + rejection).

Output is a WGS84 GeoJSON of `Point`s (`properties.cd_setor`, `.pop`).

Defaults assume the IBGE básico CSV (`;` separator, latin-1, column `v0001`).
Override with `--csv-sep`, `--csv-encoding`, `--pop-col`, `--cd-col`.

> The DEM must be **geographic (EPSG:4326)** — same constraint as the app's
> coordinate conversion. `sampa_geral.tif` is.

## 2. Compute density + export bundle — `census-density.mjs`

`npm install` (pins `geotiff@3.0.5` + `jszip@3.10.1`, the versions the app's
CDN `<script>` tags use). Then:

```sh
node census-density.mjs \
  --dem ../dem/sampa_geral.tif \
  --points points.geojson \
  --mode from --mass 75 --pflat 80 \
  -o simujoules-census.zip
```

Cost knobs are the app's **v2 physics inputs** — `--mass 75 --crr 0.008
--cda 0.45 --rho 1.1 --keff 0.97 --pflat 80 --climb-thr 2 --ksmooth 1`
(defaults shown = the app's UI defaults; `--climb-thr` is in %). The harness
folds them into the `{aRoll, aAero, beta, …}` cost bundle exactly like the
app's `readCost()` (hand-kept mirror). The v1 `--alpha/--beta/--eta` flags
were removed with the v2 cost model.

It loads the DEM, converts each point to a DEM pixel (dropping out-of-extent /
nodata points, logged), then runs the **same** `densityField` engine the PWA
uses — `../energy-worker.js`, driven through its real `onmessage` handler (the
shim from `test-worker-pool.mjs`). A single non-partial density message returns
the fully-normalised `energy` + `passes`, so there is no re-implemented math:
the engine owns it. The output is an app-importable **v3 bundle** (zip with
`metadata.jsonld` + `energy.tif` + `passes.tif`, georeferenced to the DEM).

Parity details worth knowing if you edit this:

- Density workers get `dx/dy = dxM/dyM` (**metres**) for the cost model;
  GeoTIFFs use **native** `dx/dy` + `originX/originY` (degrees) for georef.
  Both live on the `dem` object — don't conflate them.
- `metadata.dem.H/W` must equal the DEM you import against, or the app skips
  the raster replay. Use the **same** DEM in step 2 and on import.

> Performance: this runs single-process over all refs. It's fine on
> `sampa_centro.tif` (~34 MB); `sampa_geral.tif` (~540 MB) is large — try a
> smaller DEM or fewer points first.

## 3. Visualise

Open `index.html`, load the same DEM (`dem/sampa_geral.tif`), then import
`simujoules-census.zip` via the bundle loader. The passes/energy layers render
and the reference markers land in populated setores (`refSource: "census"`).
The GeoTIFFs also drop straight into QGIS.

## Testing

```sh
npm install        # once
npm test           # node test-census-density.mjs — synthetic end-to-end
node ../test-worker-pool.mjs   # engine unchanged (the harness reuses it)
```

`test-census-density.mjs` synthesises a tiny geographic GeoTIFF, runs the full
pipeline, and asserts the harness density equals the app's pooled-partial merge
and that the exported GeoTIFFs read back bit-identical.
