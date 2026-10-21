# landuse/ — Closed-Loop São Paulo

A land-use simulation of a self-sustaining São Paulo, built on the same
terrain Simujaules uses. It answers one question on a map: where would the
city put its living and circulation space, energy, food, water and
irrigation, sewage, recycling and extraction if every loop had to close
inside the **Alto Tietê** basin (UGRHI-6), or inside the **Alto Tietê +
Paraíba Valley** (UGRHI-2, the São Paulo part)?

Dev tooling, like `census/` and `mcp/`: its own `package.json`, never
deployed by `deploy.sh`, no change to the app.

## Pipeline

```sh
cd landuse && npm install
node bake.mjs all        # tiles → dem → landcover → hydro → census → export → report
node build-page.mjs      # index.src.html + Leaflet CSS → index.html
node test-landuse.mjs    # codec, hydrology, basin gate, model invariants
python3 -m http.server   # then open http://localhost:8000/
```

| Stage | Input | Output |
|---|---|---|
| `tiles` | FABDEM V1-2 1° tiles from `fabdem.pedalhidrografi.co` (the app's mirror) | `cache/fabdem/` (~420 MB) |
| `dem` | the tiles, σ 30 m smoothing via `../test-dem-smoothing.mjs` (the app's auto rule) | slope classes per 6″ cell, counted at 1″ |
| `landcover` | MapBiomas Collection 9, 2023 coverage (HTTP Range on the national COG) | cover-group fractions per cell |
| `hydro` | the 6″ surface + MapBiomas water | priority-flood, D8, accumulation, HAND, watersheds |
| `census` | IBGE 2022 setores (the app's census FGB, HTTP Range) | people per cell, state codes |
| `export` | all of the above | `data/*.png` + `data/meta.json` (~15 MB) |
| `report` | the caches | the gentle-land table below |

The page's layers travel as plain PNGs (8/16-bit, gray/RGBA) that the page
decodes **exactly** with its own decoder (`model.js decodePngAsync`, inflate
via `DecompressionStream`). Canvas decoding is never used: premultiplied
alpha and colour management would corrupt the integer data.

## Hydrology gate

Drainage is traced on the 6″ grid (~170 × 185 m). Two hydrological fixes are
needed and both are listed in `meta.json`:

- **Billings** is dammed on every side. On FABDEM its southern arms sit at
  the Rio das Pedras level, at the top of the Serra do Mar, so the traced
  reservoir drained to the sea. The Summit Control dam is restored as a
  wall, and the reservoir drains along a BFS tree to its natural outlet,
  north through Pedreira.
- Accumulation uses a Kahn topological order of the D8 tree. The flood's
  pop order is not monotone once the epsilon-filled pit queue interleaves
  with the heap; it broke accumulation along the Paraíba.

| Basin | Traced | Published | People (IBGE 2022) |
|---|---|---|---|
| Alto Tietê, outlet at Rasgão | 5,878 km² | 5,868 km² (UGRHI-6) | 20.39 M |
| Paraíba do Sul ∩ SP, outlet below Volta Redonda | 13,828 km² | 14,444 km² (UGRHI-2), −4.3 % | 2.32 M |

`test-landuse.mjs` fails if either drifts more than 5 %. Published areas:
CORHI (2004), as listed in the state water plan's UGRHI profiles
(PERH 2004–2007). The 2024 CBH-PS work plan gives 14,491 km² for UGRHI-2
(IPT 2011). Reservoir names in `RESERVOIRS` are nearest-centroid matches of
the bake's water components; the small Alto Tietê system ones are the
likeliest to need a swap.

## The slope-map answer (`node bake.mjs report`)

km² by cover × slope. Cover and slope fractions are combined as if
independent within a cell.

| | cleared* < 12 % | forest < 12 % | cleared* 12–30 % | cleared* ≥ 30 % |
|---|---:|---:|---:|---:|
| Alto Tietê | 644 | 683 | ~580 | ~117 |
| Paraíba (SP) | **2,397** | 532 | ~3,270 | ~2,350 |

\* pasture + crops + mosaic of uses (MapBiomas 15, 14/18–20/35–48/62, 21).

So machine-farmable cleared land is about **3,000 km²** across both basins.
At 0.4 % sunlight-to-food efficiency that covers roughly two-thirds of a
plant-based diet's calories. FABDEM's per-pixel noise biases slopes steep,
so these gentle shares are conservative.

## The model (`model.js`)

Pure functions shared by the page (through `worker.js`) and the test. It
allocates whole cells, each to one main use, in a fixed priority order:

1. Water and quarries.
2. The city: today's footprint with a compaction slider, or a polycentric
   redesign at a chosen density that avoids floodplains, steep land, prime
   farmland and spring catchments.
3. Timber.
4. Vegetables, nearest the city.
5. Staples on < 12 % cleared land.
6. Ground solar on north-facing moderate slopes and reclaimed urban land,
   sized to the energy gap left by rooftops, floating solar and biogas.
7. Terraces and agroforestry on 12–30 %, at 60 % of field yield.
8. Reforestation of ≥ 30 % cleared land.
9. Whatever is left: forest, floodplain parks, natural land, reserve.

Second uses are flags: rooftop solar on the city, floating solar on
reservoirs, fertigation on farms, and drinking-water catchment on farms.

The networks are built from the same grid:

- **Sewers** follow the D8 drainage by gravity. A plant goes where the load
  reaches the size cap, where a trunk leaves the city, or before a
  drinking-water reservoir.
- **Recycled-water mains** run from each plant to the nearest reservoir of
  its basin. Pumping energy uses the DEM head and `G_SP = 9.7864`, plus
  ~1 kWh/m³ of treatment.
- **Fertigation** covers the farms near each plant.
- **Treated-water mains** run by A* from reservoirs to population centres.
- **Trunk transit corridors** are a minimum spanning tree plus loops, routed
  by A* with a penalty on grades above 3 %.
- **Recycling hubs** come from Hilbert-curve population quotas.
- **Extraction sites** are the MapBiomas mining class plus three single
  sites: Cajamar and Sorocaba limestone, and a sea-salt intake.
- **Pumped storage** is Henry Borden made reversible, plus, with the
  Paraíba Valley, the best Mantiqueira head that has gentle ground for a
  reservoir at both ends.

The defaults are the assumptions this scenario was built from:

- **People:** a car-free, electrified economy with no exports, at
  5.1 MWh per person per year.
- **Food:** a plant-based diet of 2,500 kcal/day, 25 % lost between harvest
  and plate, and 0.4 % sunlight-to-food efficiency at 1,733 kWh/m²/yr.
- **Water:** 180 L per person per day for all urban uses, 12 % losses, and a
  drought-firm Alto Tietê supply of 28 m³/s.

It is a screening model on 3-hectare cells, not a plan.
