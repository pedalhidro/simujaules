# `dem/vector/` — the "Viário RMSampa" example network

This directory holds the local copy of the hosted example vector network
that the app's group 1B "Viário RMSampa" button loads
(`https://simujaules.pedalhidrografi.co/vector/sampa-viario.gpkg`,
`app.js` → `loadVectorFromUrl(...)`). It is **not staged by `deploy.sh`** —
`deploy.sh` only copies `dem/*.tif` into the deploy bucket; the bucket's
`vector/sampa-viario.gpkg` object is uploaded by hand, out-of-band, and the
rsync step's `--exclude='^(census|vector|mask|vm)(/|$)'` protects that
out-of-band prefix from `--delete-unmatched-destination-objects` (see the
comment above the `gcloud storage rsync` call in `deploy.sh`). The local
`sampa-viario.gpkg` here is **gitignored** by design (`.gitignore:231`,
`dem/*`) — it's a 145 MB binary, kept locally only as the source for that
out-of-band upload and for local testing.

## Contents

- Layer `viario`: 443,872 `LineString` features.
- CRS: EPSG:31983 — SIRGAS 2000 / UTM zone 23S.
- Columns: `fid`, `geom`, `osm_id`, `name`, `highway`, `waterway`,
  `aerialway`, `barrier`, `man_made`, `railway`, `z_order`, `other_tags` —
  the standard schema `ogr2ogr`'s "lines" layer produces from an OSM
  `.osm.pbf`/Overpass extract.
- Embedded `gpkg_metadata`: processed in QGIS 3.44.9 ("Solothurn").
- File dated 2026-06-20 in this working copy (the embedded QGIS metadata
  reference timestamp is 2026-05-05, i.e. whenever it was first produced/
  touched upstream — the two dates are both real, just from different
  steps of the pipeline).

## Source and licence

The data is **OpenStreetMap-derived** (the column schema and `other_tags`
are the OSM tag dump `ogr2ogr` produces from a `.osm.pbf` extract) and is
therefore **© OpenStreetMap contributors, ODbL 1.0** — serving it publicly
requires attribution. The app's "Viário RMSampa" example carries that
attribution in its hint text (`net.example_viario_tag`) and in the help
modal's network section (`help.p.network`), both PT and EN.

**TODO (maintainer):** record the exact extract source and date here (most
likely a Geofabrik `sudeste`/São Paulo metro extract processed through
`ogr2ogr`, but this has not been confirmed against the actual processing
steps — don't guess further than this note).

## The zero-byte stray file

`dem/sampa-viario.gpkg` (at the `dem/` root, sibling to this directory) is
a 0-byte leftover, distinct from this directory's real
`dem/vector/sampa-viario.gpkg`. Per this workspace's policy, permanent
deletions are left to the maintainer — to remove it:

```sh
rm dem/sampa-viario.gpkg
```
