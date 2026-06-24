#!/usr/bin/env python3
"""Build the cloud-hosted census FlatGeobuf consumed by the simujoules PWA.

Joins IBGE 2022 setor population (column v0001 of the "basico" aggregates CSV)
onto the national setor geometry (GeoPackage), simplifies, reprojects to
EPSG:4326, and writes a single **FlatGeobuf** (.fgb). FlatGeobuf carries a
packed Hilbert R-tree spatial index, so the browser can fetch only the setores
inside a DEM's bounding box via HTTP Range requests — a raw .gpkg cannot.

The browser ("census" sampling strategy in app.js) reads this file by bbox and
runs the SAME population-weighted Sobol sampler as census/sample_census.py.

Pipeline (pure GDAL CLI — no geopandas / osgeo bindings needed):
  1. load CD_SETOR + v0001 from the basico CSV into a `pop_basico` table in a
     working copy of the malha gpkg, indexed on CD_SETOR;
  2. ogr2ogr -f FlatGeobuf with a SQLite LEFT JOIN, -simplify, -t_srs EPSG:4326,
     promote-to-multi;
  3. drop the scratch table (unless --keep-pop-table).

Needs GDAL >= 3.x on PATH (ogr2ogr, ogrinfo) with the FlatGeobuf driver.

Example (national, after `python download_census.py --national`):
  python build_fgb.py \
    --malha census_data/BR_setores_CD2022.gpkg \
    --pop   census_data/Agregados_por_setores_basico_BR.csv \
    -o setores_br_pop.fgb

Then upload + set CORS (see README) — this file is NOT shipped by deploy.sh.
"""
from __future__ import annotations
import argparse, json, shutil, subprocess, sys
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("  $ " + " ".join(cmd))
    subprocess.run(cmd, check=True)


def capture(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def require_tool(name: str) -> None:
    if shutil.which(name) is None:
        sys.exit(f"'{name}' not found on PATH — install GDAL (>=3.x with the "
                 f"FlatGeobuf driver) and retry.")


def malha_layer_and_geom(gpkg: Path) -> tuple[str, str]:
    """First (and only) layer name + its geometry column, via ogrinfo -json."""
    info = json.loads(capture(["ogrinfo", "-json", "-so", str(gpkg)]))
    layers = info.get("layers", [])
    if not layers:
        sys.exit(f"No layers in {gpkg}")
    lyr = layers[0]
    geomfields = lyr.get("geometryFields") or [{}]
    geom = geomfields[0].get("name") or "geom"
    return lyr["name"], geom


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--malha", default="census_data/BR_setores_CD2022.gpkg", type=Path,
                    help="IBGE malha de setores GeoPackage (national or one UF).")
    ap.add_argument("--pop", default="census_data/Agregados_por_setores_basico_BR.csv",
                    type=Path, help="Agregados basico CSV (per-setor).")
    ap.add_argument("--pop-col", default="v0001", help="Population column (v0001 = total).")
    ap.add_argument("--cd-col", default="CD_SETOR", help="Setor-code join column.")
    ap.add_argument("--simplify", type=float, default=0.0001,
                    help="Douglas-Peucker tolerance in DEGREES (~0.0001 deg ~ 11 m). "
                         "Conservative on purpose: aggressive values can push a "
                         "sampled point across a real setor edge.")
    ap.add_argument("-o", "--out", default=Path("setores_br_pop.fgb"), type=Path)
    ap.add_argument("--keep-pop-table", action="store_true",
                    help="Leave the scratch pop_basico table in the working gpkg.")
    ap.add_argument("--work", type=Path, default=None,
                    help="Working gpkg copy (default: <out>.work.gpkg). The source "
                         "malha is never mutated.")
    args = ap.parse_args()

    for t in ("ogr2ogr", "ogrinfo"):
        require_tool(t)
    if not args.malha.exists():
        sys.exit(f"--malha not found: {args.malha} (run download_census.py --national)")
    if not args.pop.exists():
        sys.exit(f"--pop not found: {args.pop}")

    layer, geom = malha_layer_and_geom(args.malha)
    csv_layer = args.pop.stem
    work = args.work or args.out.with_suffix(".work.gpkg")
    print(f"malha layer: {layer} (geom={geom})  |  pop: {csv_layer}.{args.pop_col}")

    # The source gpkg is large (~1.5 GB national); copy it so the scratch
    # pop table + index never touch the user's download. A reflink copy is
    # near-instant on APFS; falls back to a full copy elsewhere.
    print(f"[1/4] working copy -> {work}")
    if work.exists():
        work.unlink()
    try:
        subprocess.run(["cp", "-c", str(args.malha), str(work)], check=True)  # APFS clone
    except subprocess.CalledProcessError:
        shutil.copy2(args.malha, work)

    print(f"[2/4] load {args.pop_col} into pop_basico + index")
    run(["ogr2ogr", "-f", "GPKG", "-update", str(work), str(args.pop),
         "-sql", f"SELECT {args.cd_col}, {args.pop_col} FROM {csv_layer}",
         "-nln", "pop_basico", "-nlt", "NONE"])
    run(["ogrinfo", str(work),
         "-sql", f"CREATE INDEX IF NOT EXISTS idx_pop_cd ON pop_basico({args.cd_col})"])

    print(f"[3/4] join + simplify({args.simplify} deg) + EPSG:4326 -> FlatGeobuf")
    if args.out.exists():
        args.out.unlink()
    sql = (f"SELECT s.{geom}, CAST(p.{args.pop_col} AS REAL) AS pop, "
           f"s.{args.cd_col} AS cd_setor "
           f"FROM {layer} s LEFT JOIN pop_basico p "
           f"ON s.{args.cd_col} = p.{args.cd_col}")
    run(["ogr2ogr", "-f", "FlatGeobuf", "-t_srs", "EPSG:4326",
         "-nlt", "PROMOTE_TO_MULTI", "-simplify", str(args.simplify),
         "-nln", "setores", "-dialect", "SQLITE", "-sql", sql,
         str(args.out), str(work)])

    if not args.keep_pop_table:
        work.unlink(missing_ok=True)

    print(f"[4/4] done -> {args.out}  ({args.out.stat().st_size/1e6:.1f} MB)")
    # Quick sanity summary (feature count + that pop is populated).
    summ = capture(["ogrinfo", "-q", str(args.out), "-dialect", "SQLITE",
                    "-sql", "SELECT COUNT(*) n, SUM(CASE WHEN pop>0 THEN 1 ELSE 0 END) pos, "
                            "MAX(pop) mx FROM setores"])
    print(summ.strip())
    print("\nNext: upload + CORS (see README) — NOT shipped by deploy.sh:")
    print(f"  gcloud storage cp {args.out} gs://simujaules/census/{args.out.name}")


if __name__ == "__main__":
    main()
