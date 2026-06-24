#!/usr/bin/env python3
"""One-shot downloader for IBGE Censo 2022 census-sector data.

Fetches into ./census_data/:
  1. Malha de setores censitarios 2022 (geometry, GeoPackage) — one UF, or the
     whole country (`--national`, a single ~1.5 GB BR_setores_CD2022.gpkg).
  2. Agregados por setor - "basico" table (national zip; total population is
     column v0001), unzipped to its CSV.

`--national` is the input for build_fgb.py, which produces the cloud-hosted
FlatGeobuf the PWA's "census" sampling reads. `--uf SP` keeps the old offline
sample_census.py path working on a single state.

Stdlib only. Re-running skips files already present.
"""
from __future__ import annotations
import argparse, zipfile, urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (simujoules census downloader)"

# Geometry GeoPackage. Per-UF files live under .../gpkg/UF/<UF>/<UF>_..., the
# national file under .../gpkg/BR/BR_... — so the directory segment differs.
MALHA_BASE = (
    "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/"
    "malhas_de_setores_censitarios__divisoes_intramunicipais/censo_2022/"
    "setores/gpkg"
)


def malha_url(code: str) -> str:
    """code='BR' -> national file; code='SP' -> that UF's file."""
    seg = "BR" if code == "BR" else f"UF/{code}"
    return f"{MALHA_BASE}/{seg}/{code}_setores_CD2022.gpkg"
# NOTE: the date suffix changes when IBGE republishes. If this 404s, list
# .../Agregados_por_Setores_Censitarios/Agregados_por_Setor_csv/ for the
# current "basico" filename.
BASICO_URL = (
    "https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/"
    "Agregados_por_Setores_Censitarios/Agregados_por_Setor_csv/"
    "Agregados_por_setores_basico_BR_20260520.zip"
)
DICT_URL = (
    "https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/"
    "Agregados_por_Setores_Censitarios/"
    "dicionario_de_dados_agregados_por_setores_censitarios_20260520.xlsx"
)


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  skip (exists): {dest.name}")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    print(f"  GET {url}")
    with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r    {done/1e6:7.1f} / {total/1e6:.1f} MB "
                      f"({100*done/total:5.1f}%)", end="")
        print()
    tmp.replace(dest)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description="Download IBGE Censo 2022 sector data.")
    ap.add_argument("--uf", default="SP", help="State abbreviation (default SP).")
    ap.add_argument("--national", action="store_true",
                    help="Fetch the single national BR malha (~1.5 GB) instead of "
                         "one UF — the input for build_fgb.py.")
    ap.add_argument("-o", "--out", default=Path("census_data"), type=Path)
    ap.add_argument("--dict", action="store_true", help="Also fetch the data dictionary.")
    args = ap.parse_args()
    code = "BR" if args.national else args.uf.upper()
    out = args.out

    print(f"[1/2] Malha de setores ({code}) ...")
    download(malha_url(code), out / f"{code}_setores_CD2022.gpkg")

    print("[2/2] Agregados basico (BR) ...")
    zpath = download(BASICO_URL, out / "Agregados_por_setores_basico_BR.zip")
    with zipfile.ZipFile(zpath) as z:
        for name in z.namelist():
            if name.lower().endswith(".csv"):
                target = out / Path(name).name
                if not target.exists():
                    print(f"  unzip: {name} -> {target.name}")
                    target.write_bytes(z.read(name))

    if args.dict:
        print("[+] Data dictionary ...")
        download(DICT_URL, out / "dicionario_agregados_setores.xlsx")

    print(f"\nDone -> {out.resolve()}")
    print(f"  malha:   {code}_setores_CD2022.gpkg   (join key: CD_SETOR)")
    print("  pop CSV: basico CSV                 (total population = v0001)")
    if args.national:
        print("  next:    python build_fgb.py   (-> setores_br_pop.fgb)")


if __name__ == "__main__":
    main()
