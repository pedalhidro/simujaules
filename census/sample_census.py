#!/usr/bin/env python3
"""Population-weighted reference-point sampler for simujoules.

Reads a local IBGE Censo 2022 malha de setores censitarios (GeoPackage /
shapefile) plus the per-setor "basico" aggregates CSV, filters setores to a
DEM's bounding box, and samples N points using each setor's population as the
likelihood. Both setor selection AND in-polygon placement use a Sobol
(low-discrepancy) sequence. Output: a WGS84 GeoJSON FeatureCollection of
Point features, consumed by census-density.mjs.

Plan steps:
  1/2. filter geometries fully or partially inside the DEM extent
  3.   sample N points ~ population, uniform-within-polygon (Sobol)

Example:
  python sample_census.py \
    --malha census_data/SP_setores_CD2022.gpkg \
    --pop   census_data/Agregados_por_setores_basico_BR.csv \
    --dem   ../dem/sampa_geral.tif \
    -n 512 -o points.geojson
"""
from __future__ import annotations
import argparse, json, sys, warnings
import numpy as np

# geopandas .area on a geographic CRS warns; we only use AREA RATIOS (clip
# fraction), which are valid in any consistent CRS, so silence the noise.
warnings.filterwarnings("ignore", message=".*Geometry is in a geographic CRS.*")


def read_bbox(dem_path, bbox_arg):
    """Return (xmin, ymin, xmax, ymax, epsg) for the DEM extent."""
    if bbox_arg:
        xmin, ymin, xmax, ymax = (float(v) for v in bbox_arg)
        return xmin, ymin, xmax, ymax, None
    import rasterio
    with rasterio.open(dem_path) as ds:
        b = ds.bounds
        epsg = ds.crs.to_epsg() if ds.crs else None
        return b.left, b.bottom, b.right, b.top, epsg


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--malha", required=True, help="IBGE malha de setores (gpkg/shp).")
    ap.add_argument("--pop", required=True, help="Agregados basico CSV (per-setor).")
    ap.add_argument("--pop-col", default="v0001",
                    help="Population column (default v0001 = total de pessoas).")
    ap.add_argument("--cd-col", default="CD_SETOR",
                    help="Setor-code join column (default CD_SETOR).")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--dem", help="DEM GeoTIFF; bbox+CRS read from header (needs rasterio).")
    src.add_argument("--bbox", nargs=4, metavar=("XMIN", "YMIN", "XMAX", "YMAX"),
                     help="DEM bbox in lon/lat (skips rasterio).")
    ap.add_argument("-n", "--num", type=int, default=256, help="Points to sample.")
    ap.add_argument("--seed", type=int, default=12345, help="Sobol scramble seed.")
    ap.add_argument("--csv-sep", default=";", help="Population CSV separator (IBGE uses ';').")
    ap.add_argument("--csv-encoding", default="latin-1", help="Population CSV encoding.")
    ap.add_argument("-o", "--out", default="points.geojson")
    args = ap.parse_args()

    import geopandas as gpd
    import pandas as pd
    from shapely.geometry import box, Point
    from scipy.stats import qmc

    xmin, ymin, xmax, ymax, dem_epsg = read_bbox(args.dem, args.bbox)
    # Output (and filtering) is done in the DEM's CRS, which for simujoules is
    # geographic lon/lat (EPSG:4326). census-density.mjs reads [lng, lat].
    target_crs = f"EPSG:{dem_epsg}" if dem_epsg else "EPSG:4326"
    print(f"DEM bbox ({target_crs}): "
          f"[{xmin:.5f}, {ymin:.5f}, {xmax:.5f}, {ymax:.5f}]", file=sys.stderr)

    # 1/2. Load malha, reproject to DEM CRS, filter to setores intersecting the
    #      bbox. gpd .cx captures fully- AND partially-contained polygons.
    gdf = gpd.read_file(args.malha)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4674")  # SIRGAS 2000 — IBGE default
    gdf = gdf.to_crs(target_crs)
    if args.cd_col not in gdf.columns:
        sys.exit(f"--cd-col '{args.cd_col}' not in malha columns: {list(gdf.columns)}")
    gdf = gdf[[args.cd_col, "geometry"]].copy()
    gdf[args.cd_col] = gdf[args.cd_col].astype(str)
    sub = gdf.cx[xmin:xmax, ymin:ymax].copy()
    print(f"setores intersecting extent: {len(sub)} / {len(gdf)}", file=sys.stderr)
    if sub.empty:
        sys.exit("No setores intersect the DEM extent — check CRS / bbox.")

    # Population join. Read CD_SETOR as string so the 15-digit code keeps its
    # leading zeros; coerce the population column to numeric.
    pop = pd.read_csv(args.pop, sep=args.csv_sep, encoding=args.csv_encoding,
                      dtype={args.cd_col: str})
    if args.pop_col not in pop.columns:
        sys.exit(f"--pop-col '{args.pop_col}' not in CSV columns: {list(pop.columns)[:12]}")
    pop = pop[[args.cd_col, args.pop_col]].copy()
    pop[args.pop_col] = pd.to_numeric(pop[args.pop_col], errors="coerce")
    sub = sub.merge(pop, on=args.cd_col, how="left")

    # 3. Clip each setor to the bbox so sampled points stay inside the DEM, and
    #    weight by population *inside the extent*: pop x (clipped / full area).
    clip_box = box(xmin, ymin, xmax, ymax)
    full_area = sub.geometry.area.to_numpy()
    sub = sub.assign(geometry=sub.geometry.intersection(clip_box))
    clip_area = sub.geometry.area.to_numpy()
    frac = np.divide(clip_area, full_area,
                     out=np.zeros_like(clip_area, dtype=float), where=full_area > 0)
    w = pd.to_numeric(sub[args.pop_col], errors="coerce").to_numpy(dtype=float) * frac
    keep = np.isfinite(w) & (w > 0) & (~sub.geometry.is_empty.to_numpy())
    sub = sub[keep].reset_index(drop=True)
    w = w[keep]
    if w.sum() <= 0:
        sys.exit("Total population weight is zero after filtering.")
    print(f"setores with population in-extent: {len(sub)} "
          f"(sum pop ~ {w.sum():.0f})", file=sys.stderr)

    geoms = list(sub.geometry.values)
    bounds = np.array([g.bounds for g in geoms])      # [minx,miny,maxx,maxy]
    codes = sub[args.cd_col].to_numpy()
    pops = pd.to_numeric(sub[args.pop_col], errors="coerce").to_numpy(dtype=float)

    # --- Sobol-driven sampling ------------------------------------------------
    # (a) population-weighted setor selection via the inverse CDF of a 1-D Sobol
    #     sequence; (b) uniform-in-polygon placement via a per-setor 2-D Sobol
    #     stream with bbox rejection.
    cdf = np.cumsum(w) / w.sum()
    sel_engine = qmc.Sobol(d=1, scramble=True, seed=args.seed)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")               # non-power-of-2 balance warning
        u = sel_engine.random(args.num).ravel()
    sel = np.clip(np.searchsorted(cdf, u, side="right"), 0, len(geoms) - 1)

    pos_engines: dict[int, object] = {}
    feats = []
    for k in sel:
        k = int(k)
        g = geoms[k]
        minx, miny, maxx, maxy = bounds[k]
        eng = pos_engines.get(k)
        if eng is None:
            eng = qmc.Sobol(d=2, scramble=True, seed=args.seed + k + 1)
            pos_engines[k] = eng
        pt = None
        for _ in range(64):                           # rejection cap
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                qx, qy = eng.random(1)[0]
            cand = Point(minx + qx * (maxx - minx), miny + qy * (maxy - miny))
            if g.contains(cand):
                pt = cand
                break
        if pt is None:
            pt = g.representative_point()              # degenerate sliver fallback
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [pt.x, pt.y]},
            "properties": {"cd_setor": str(codes[k]), "pop": float(pops[k])},
        })

    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name",
                "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": feats,
    }
    with open(args.out, "w") as f:
        json.dump(fc, f)
    print(f"wrote {len(feats)} points -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
