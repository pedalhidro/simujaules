# census/ — population-weighted reference sampling (IBGE Censo 2022)

Offline tooling that seeds a simujoules **passes-density** field from the real
population distribution instead of uniform/random reference points. The idea:
reference "trips" should originate where people actually live, so the density
field over a DEM approximates real cycling demand.

Three small scripts, run in order. Nothing here is shipped — `deploy.sh` only
stages an explicit file list, so `census/` never reaches users (same status as
`backend/` and the `test-*.mjs` files).

```
download_census.py  →  sample_census.py  →  census-density.mjs
   (IBGE files)         (points.geojson)      (simujoules-*.zip)
```

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
  --mode from --alpha 1 --beta 30 --eta 0.3 \
  -o simujoules-census.zip
```

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
