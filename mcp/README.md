# Simujaules MCP server

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets an agent —
Claude Code, Claude Desktop, any MCP client — load a DEM and ask Simujaules
for cycling **energy** fields, routes and corridor density. It drives the
very same `energy-worker.js` the PWA runs, with the app's DEM pre-smoothing
and the app's cost derivation, so the numbers are the app's numbers.

Dev tooling, like `census/`: lives in the repo, never deploys
(`deploy.sh` ships only listed files).

## Install & register

```sh
cd mcp && npm install          # also runs `npm install` in ../census (postinstall):
                               # the server imports census/census-density.mjs, whose
                               # geotiff/jszip resolve from census/node_modules
node test-mcp.mjs              # self-contained test (synthetic DEMs, real stdio)
```

Claude Code (pick one form):

```sh
claude mcp add simujaules -- node /ABS/PATH/simujaules/mcp/server.mjs
# or preload a DEM at startup (optional --smooth auto|<σ metres>)
claude mcp add simujaules-sampa -- node /ABS/PATH/simujaules/mcp/server.mjs --dem /ABS/PATH/dem.tif --smooth auto
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "simujaules": { "command": "node", "args": ["/ABS/PATH/simujaules/mcp/server.mjs"] } } }
```

## Tools

| tool | what it does |
| --- | --- |
| `load_dem` | Load a GeoTIFF (`path`, optional `label`, `smooth`: `"auto"` = σ 30 m like the app, or a σ in metres, 0 = raw). Returns grid, extent, cell size, elevation range. Replaces the previous DEM. |
| `dem_info` | Describe the loaded DEM and which field is cached. |
| `energy_field` | Single-source field `from` / `to` / `round` a point: energy (kJ) + passes count for every cell. Returns statistics; caches the field; writes files when `outDir` is given. |
| `route` | Minimum-energy path between two points, optional `topN` diverse alternatives, optional `stringPull`. Returns kJ, length, GeoJSON (cell centres, lon/lat, thinned to `maxVertices` inline — files keep every vertex). Caches the source field. |
| `energy_at` | Sample the last field at points: energy, passes count (after `density`: the normalised density), smoothed elevation. No recompute. |
| `density` | Multi-reference passes density (one Dijkstra per ref, summed and normalised) + per-cell mean energy. Duplicated refs are weights. |

Points are `{lon, lat}` in the DEM's CRS units (degrees on a geographic
DEM, metres on a projected one) or `{row, col}` pixels. Physics inputs
(`mass`, `crr`, `cda`, `rho`, `keff`, `pFlat`, `climbThrPct`, `kSmooth`), the
budget (`eMax`, `eMaxMode`) and `nDirs` (4, 8, 16, 32, 64 or 128; default 16)
default to the app's UI defaults. One compute (or DEM load) runs at a time; a
second call meanwhile is refused with an error rather than queued. Long
runs report MCP progress notifications and honour cancellation.

Outputs with `outDir`: `<name>.zip` (an app-importable bundle —
`metadata.jsonld` + `energy.tif` + `passes.tif` + `routes.geojson` /
`path.geojson`), plus loose `<name>.energy.tif`, `<name>.passes.tif` and
`<name>.geojson` for QGIS. Import the zip in the app over the **same** DEM
to visualise. The bundle carries no `viz`/`config` blocks (a headless run
makes no style decisions) and records `demSmooth` only when the σ is one of
the app's menu values (`demSmoothAppliedSigmaM` always holds the truth).

## Parity with the app (what is and isn't reproduced)

Reproduced bit for bit for a run with no vector network, no bridges and no
impassable/drawn layers:

- DEM read (`census/census-density.mjs` `loadDem`, the app's loader: band 0,
  f32-rounded nodata, GeoKey-first CRS test, flat-earth cell size), then
  `smoothHeightsInPlace` (imported from `test-dem-smoothing.mjs`, the
  byte-identical mirror) under the app's auto rule — σ 30 m unless the file
  is an app `dem.tif` export carrying its smoothing tag.
- The run message is app.js's `baseMsg` (`lib.mjs` `buildRunMessage`): dx/dy
  in metres, `wantPasses` always on, the v2 cost bundle from `deriveCost`
  (the `readCost` mirror — São Paulo gravity lives there, not here).
- Density is the app's pool merge with one slice (`census` `runDensity`,
  which builds its own run message — keep both in step with app.js).
- Energies shown are the engine's own numbers: `pathEnergy` is the f32 field
  value at the goal (or the pulled polyline's own f64 per-edge sum when
  `stringPull` shortened it), top-N energies the f64 per-edge re-sum, exactly
  as the app displays and exports them (viewing ≡ routing).

Not (yet) exposed: OSM street networks and graph mode, bridge portals,
impassable water, drawn barriers, maximize mode, the accessibility matrix /
KPIs, the Rust backend. Those stay browser-side for now.

## Layout

- `server.mjs` — MCP wiring only (tool schemas, one compute at a time,
  progress notifications, cancellation, `--dem` preload, clean exit when the
  client disconnects). Never writes to stdout.
- `lib.mjs` — headless library: DEM load + smoothing rule, run-message
  builder, worker-thread runners (engine + DEM load), GeoJSON/bundle
  writers, wire thinning. Reusable from plain node scripts.
- `engine-thread.mjs` — hosts `energy-worker.js` inside a `worker_threads`
  Worker with a Web-Worker-shaped `self`/`postMessage` (the threaded twin of
  the census `loadWorker()` shim), so runs are cancellable and non-blocking.
- `dem-thread.mjs` — the same for the DEM decode + σ 30 m smoothing (~20 s
  on a 135 M-cell DEM), so the server keeps answering meanwhile.
- `test-mcp.mjs` — the test above.
