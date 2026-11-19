// Deterministic input fixtures for smoke.mjs (all generated in Node, no
// randomness, no clock): the synthetic DEM, a street-network GeoPackage, an
// impassable-mask GeoTIFF, two GPX tracks, a canned Overpass response, and the
// coastal set for the water pulls (a second DEM with a sea, canned Overpass
// water/coastline answers, FlatGeobuf-shaped features and their oracle).
//
// Everything lives on ONE grid: 240 x 200 cells of 1 arc-second, EPSG:4326,
// north-west corner (-46.66, -23.53) near Sao Paulo centre. Geometry is placed
// at cell CENTRES so the app's floor() rasterisation is unambiguous.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeArrayBuffer } = await import("geotiff");

export const DEM = { W: 240, H: 200, lon0: -46.66, lat0: -23.53, d: 1 / 3600 };
// Cell centre (row, col) -> [lat, lng].
export const cellLL = (r, c) => [DEM.lat0 - (r + 0.5) * DEM.d, DEM.lon0 + (c + 0.5) * DEM.d];

const GEO = (extra = {}) => ({
  ModelPixelScale: [DEM.d, DEM.d, 0],
  ModelTiepoint: [0, 0, 0, DEM.lon0, DEM.lat0, 0],
  GTModelTypeGeoKey: 2,
  GTRasterTypeGeoKey: 1,
  GeographicTypeGeoKey: 4326,
  GeogCitationGeoKey: "WGS 84",
  ...extra,
});

// Float32 DEM: a gentle tilt, four Gaussian hills/hollows and a small ripple.
// (Unchanged since harness v1 — its bytes are pinned by report.dem.tiffSha256.)
export function makeDemTiff() {
  const { W, H } = DEM;
  const z = new Float32Array(W * H);
  const hills = [
    // [row, col, amplitude m, sigma cells]
    [50, 60, 55, 28],
    [140, 170, 70, 35],
    [110, 90, -30, 22],
    [30, 200, 40, 18],
  ];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let h = 760 + 0.08 * r - 0.05 * c;
      for (const [hr, hc, a, s] of hills) {
        const q = ((r - hr) ** 2 + (c - hc) ** 2) / (2 * s * s);
        h += a * Math.exp(-q);
      }
      h += 1.5 * Math.sin(r * 0.37) * Math.cos(c * 0.29) + 0.6 * Math.sin((r + 2 * c) * 0.11);
      z[r * W + c] = h;
    }
  }
  return Buffer.from(writeArrayBuffer(z, { width: W, height: H, ...GEO() }));
}

// Uint8 impassable mask on the DEM grid: a "river" band across rows 96..99
// with a ford (gap) at cols 200..239.
export const MASK_BAND = { r0: 96, r1: 99, cGap: 200 };
export function makeMaskTiff() {
  const { W, H } = DEM;
  const m = new Uint8Array(W * H);
  for (let r = MASK_BAND.r0; r <= MASK_BAND.r1; r++) for (let c = 0; c < MASK_BAND.cGap; c++) m[r * W + c] = 1;
  return Buffer.from(writeArrayBuffer(m, { width: W, height: H, ...GEO() }));
}

// Street network (cell coordinates [row, col]): a 5 x 5 grid, one diagonal, one
// dead-end spur, and one bridge way (bridge=yes, layer=1) that crosses the
// col-70 street between junctions.
export const NETWORK = [
  ...[30, 70, 110, 150, 185].map((r, i) => ({ cells: [[r, 10], [r, 230]], name: `rua-h${i}` })),
  ...[20, 70, 120, 170, 220].map((c, i) => ({ cells: [[20, c], [190, c]], name: `rua-v${i}` })),
  { cells: [[30, 70], [90, 145], [150, 220]], name: "diagonal" },
  { cells: [[150, 120], [170, 140]], name: "beco" },                       // dead end
  { cells: [[100, 40], [100, 100]], name: "viaduto", bridge: "yes", layer: 1 },
];

// GeoPackage with the same schema the app's own writer (app/network.js
// buildGeoPackage) produces, so the app's reader takes its normal path (no
// rtree -> full scan). gpkg_contents.last_change is a fixed string.
export async function makeNetworkGpkg() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const WKT = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
  db.run("PRAGMA application_id = 1196444487;");
  db.run("PRAGMA user_version = 10401;");
  db.run("CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);");
  db.run("CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change TEXT NOT NULL, min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);");
  db.run("CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, PRIMARY KEY (table_name, column_name));");
  db.run("INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS',-1,'NONE',-1,'undefined',''),('Undefined geographic SRS',0,'NONE',0,'undefined',''),('WGS 84 geodetic',4326,'EPSG',4326,?,'');", [WKT]);
  db.run('CREATE TABLE "streets" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB, "name" TEXT, "bridge" TEXT, "layer" INTEGER);');
  db.run("INSERT INTO gpkg_geometry_columns VALUES ('streets', 'geom', 'LINESTRING', 4326, 0, 0);");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const stmt = db.prepare('INSERT INTO "streets" (geom, "name", "bridge", "layer") VALUES (?, ?, ?, ?);');
  for (const f of NETWORK) {
    const ll = f.cells.map(([r, c]) => cellLL(r, c));
    for (const [lat, lng] of ll) {
      minX = Math.min(minX, lng); maxX = Math.max(maxX, lng);
      minY = Math.min(minY, lat); maxY = Math.max(maxY, lat);
    }
    stmt.run([encodeGpkgLineString(ll), f.name, f.bridge ?? null, f.layer ?? null]);
  }
  stmt.free();
  db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, last_change, min_x, min_y, max_x, max_y, srs_id) VALUES ('streets', 'features', 'streets', '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, 4326);",
    [minX, minY, maxX, maxY]);
  const out = Buffer.from(db.export());
  db.close();
  return out;
}

// StandardGeoPackageBinary LineString (8-byte header, no envelope, LE WKB).
function encodeGpkgLineString(latlngs) {
  const n = latlngs.length;
  const dv = new DataView(new ArrayBuffer(8 + 9 + n * 16));
  let o = 0;
  dv.setUint8(o++, 0x47); dv.setUint8(o++, 0x50); dv.setUint8(o++, 0); dv.setUint8(o++, 1);
  dv.setInt32(o, 4326, true); o += 4;
  dv.setUint8(o++, 1); dv.setUint32(o, 2, true); o += 4; dv.setUint32(o, n, true); o += 4;
  for (const [lat, lng] of latlngs) { dv.setFloat64(o, lng, true); o += 8; dv.setFloat64(o, lat, true); o += 8; }
  return new Uint8Array(dv.buffer);
}

// Canonical, timestamp-free digest of a GeoPackage's feature rows: every user
// table's rows (geometry blobs hex-encoded), ordered by fid. Used to hash the
// app's exported .gpkg, whose gpkg_contents.last_change is a wall-clock stamp.
export async function gpkgFeatureDump(buf) {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(buf));
  try {
    const tables = db.exec("SELECT table_name FROM gpkg_geometry_columns ORDER BY table_name")[0]?.values.map((v) => v[0]) || [];
    const out = {};
    for (const t of tables) {
      const res = db.exec(`SELECT * FROM "${t}" ORDER BY fid`)[0];
      out[t] = res ? {
        columns: res.columns,
        rows: res.values.map((row) => row.map((v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))),
      } : { columns: [], rows: [] };
    }
    return out;
  } finally {
    db.close();
  }
}

// GPX tracks across the DEM: one with <ele> (GPX elevation is used), one
// without (the app samples the DEM).
export const GPX_CELLS = [[40, 30], [60, 80], [90, 120], [120, 150], [150, 200]];
export function makeGpx({ withEle }) {
  const pts = GPX_CELLS.map(([r, c], i) => {
    const [lat, lng] = cellLL(r, c);
    const ele = withEle ? `<ele>${(760 + 7 * i + (i % 2 ? 3.5 : 0)).toFixed(1)}</ele>` : "";
    return `      <trkpt lat="${lat.toFixed(8)}" lon="${lng.toFixed(8)}">${ele}</trkpt>`;
  }).join("\n");
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="simujaules-e2e" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>e2e-${withEle ? "ele" : "noele"}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`);
}

// Canned Overpass `out geom` answer: two crossing avenues at grade, plus a
// bridge (bridge=yes, layer=1) that crosses the north-south avenue WITHOUT a
// shared node — graph mode must not join them at the crossing.
export function overpassResponse() {
  const way = (id, cells, tags) => ({
    type: "way", id, tags,
    geometry: cells.map(([r, c]) => { const [lat, lon] = cellLL(r, c); return { lat, lon }; }),
  });
  return {
    version: 0.6, generator: "simujaules-e2e canned",
    osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z" },
    elements: [
      way(1001, [[100, 10], [100, 230]], { highway: "secondary", name: "Av. Leste-Oeste" }),
      way(1002, [[20, 120], [190, 120]], { highway: "secondary", name: "Av. Norte-Sul" }),
      way(1003, [[60, 60], [60, 180]], { highway: "residential", name: "Rua Norte" }),
      way(1004, [[140, 100], [140, 140]], { highway: "primary", name: "Viaduto", bridge: "yes", layer: "1" }),
      way(1005, [[140, 20], [140, 100]], { highway: "primary", name: "Rampa Oeste" }),
      way(1006, [[140, 140], [140, 220]], { highway: "primary", name: "Rampa Leste" }),
    ],
  };
}

// ---------------------------------------------------------------- coast (group t)
// A coastal scene on the SAME grid, shaped like Fortaleza: sea to the NORTH and
// EAST of a cape. The coastline (cells [row, col], vertices at cell centres) is
// directed like OSM's — land on the LEFT of travel: north up the east coast,
// round the cape, west along the north shore — and starts/ends OUTSIDE the grid.
// Rows above its northernmost in-grid point (~45) and columns east of its
// easternmost one (~201) never cross it: that north-east block is the sea
// sweep's far field (COAST.farField), the corner the app left open until v84.
export const COAST = {
  line: [[206, 201], [150, 196], [100, 186], [72, 174], [66, 150], [74, 120], [60, 60], [44, -6]],
  // OSM hands the coast over in several ways; split at these vertex indices.
  splits: [0, 2, 5, 7],
  farField: { r0: 0, r1: 40, c0: 205, c1: 239 },
  lagoon: { r0: 120, r1: 140, c0: 60, c1: 90 },   // natural=water, closed way
  river: [[180, 30], [150, 110]],                 // waterway=river
  tunnelRiver: [[100, 30], [100, 100]],           // waterway=river + tunnel=yes: stays passable
};

// Even-odd point-in-polygon in (row, col) space — the ORACLE, deliberately not
// the app's rasteriser. Land = left of the coastline, closed far to the SW.
const COAST_LAND_RING = [...COAST.line, [900, -6], [900, 201]];
function inRing(r, c, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ri, ci] = ring[i], [rj, cj] = ring[j];
    if ((ri > r) !== (rj > r) && c < ci + (r - ri) / (rj - ri) * (cj - ci)) inside = !inside;
  }
  return inside;
}
function distToLine(r, c, line) {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [r0, c0] = line[i], [r1, c1] = line[i + 1];
    const dr = r1 - r0, dc = c1 - c0;
    const u = Math.max(0, Math.min(1, ((r - r0) * dr + (c - c0) * dc) / (dr * dr + dc * dc)));
    best = Math.min(best, Math.hypot(r - (r0 + u * dr), c - (c0 + u * dc)));
  }
  return best;
}
export const coastIsLand = (r, c) => inRing(r, c, COAST_LAND_RING);

// Float32 DEM for the coastal scene: the sea is VALID terrain at exactly 0 m
// (as in FABDEM), the land a low, gently rolling plain (3–40 m).
export function makeCoastDemTiff() {
  const { W, H } = DEM;
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!coastIsLand(r, c)) continue;
    z[r * W + c] = 3 + 0.12 * (r - 40) * (c < 200 ? 1 : 0.5) / 2 + 6 * (1 + Math.sin(r * 0.21) * Math.cos(c * 0.17)) + 0.02 * (240 - c);
  }
  return Buffer.from(writeArrayBuffer(z, { width: W, height: H, ...GEO() }));
}

const osmWay = (id, cells, tags) => ({
  type: "way", id, tags,
  geometry: cells.map(([r, c]) => { const [lat, lon] = cellLL(r, c); return { lat, lon }; }),
});
const lagoonRing = () => { const { r0, r1, c0, c1 } = COAST.lagoon; return [[r0, c0], [r0, c1], [r1, c1], [r1, c0], [r0, c0]]; };
function coastWays() {
  const ways = [];
  for (let i = 0; i + 1 < COAST.splits.length; i++) {
    ways.push(osmWay(2001 + i, COAST.line.slice(COAST.splits[i], COAST.splits[i + 1] + 1), { natural: "coastline" }));
  }
  return [ways[1], ways[2], ways[0]]; // Overpass does not return them in travel order
}
const osmEnvelope = (elements) => ({
  version: 0.6, generator: "simujaules-e2e canned",
  osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z" },
  elements,
});
// What the OSM water pull's query returns (areas + rivers + coastline).
export function overpassWaterResponse() {
  return osmEnvelope([
    osmWay(2101, lagoonRing(), { natural: "water", water: "lagoon" }),
    osmWay(2102, COAST.river, { waterway: "river" }),
    osmWay(2103, COAST.tunnelRiver, { waterway: "river", tunnel: "yes" }),
    ...coastWays(),
  ]);
}
// What the FGB pull's coastline-only query returns.
export function overpassCoastResponse() { return osmEnvelope(coastWays()); }
// Overpass's HTTP-200 answer to a query that timed out server-side.
export function overpassTimeoutResponse() {
  return { ...osmEnvelope([]), remark: 'runtime error: Query timed out in "query" at line 1 after 16 seconds.' };
}
// The same lagoon and river as GeoJSON features, as the water FlatGeobufs would
// stream them (no tunnel tag there — and no tunnelled river in this fixture, so
// the two pulls must build the same mask).
export function fgbWaterFeatures() {
  const ll = ([r, c]) => { const [lat, lon] = cellLL(r, c); return [lon, lat]; };
  return {
    areas: [{ type: "Feature", properties: { natural: "water" }, geometry: { type: "Polygon", coordinates: [lagoonRing().map(ll)] } }],
    rivers: [{ type: "Feature", properties: { waterway: "river" }, geometry: { type: "LineString", coordinates: COAST.river.map(ll) } }],
  };
}

// Check an exported impassable mask (Uint8, 1 = impassable) of the coastal
// scene against the oracle. `sea`: whether the sea is expected to be blocked
// (true) or left open (false — the coastline was unavailable). Cells within 1.5
// cells of the coastline, the lagoon edge or the river are not judged (the app
// stamps the shore and the river with a supercover line).
export function checkCoastMask(mask, { sea }) {
  const { W, H } = DEM;
  const errors = [];
  const n = { seaCells: 0, seaBlocked: 0, landCells: 0, landBlocked: 0, lagoonCells: 0, lagoonBlocked: 0, farFieldCells: 0, farFieldBlocked: 0, impassable: 0 };
  const L = COAST.lagoon, F = COAST.farField;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const m = mask[r * W + c] ? 1 : 0;
    n.impassable += m;
    if (r >= F.r0 && r <= F.r1 && c >= F.c0 && c <= F.c1) { n.farFieldCells++; n.farFieldBlocked += m; }
    if (distToLine(r, c, COAST.line) <= 1.5) continue;
    if (!coastIsLand(r, c)) { n.seaCells++; n.seaBlocked += m; continue; }
    if (r > L.r0 && r < L.r1 && c > L.c0 && c < L.c1) { n.lagoonCells++; n.lagoonBlocked += m; continue; }
    if (distToLine(r, c, lagoonRing()) <= 1.5 || distToLine(r, c, COAST.river) <= 1.5) continue;
    n.landCells++; n.landBlocked += m;
  }
  if (sea && n.seaBlocked !== n.seaCells) errors.push(`${n.seaCells - n.seaBlocked} of ${n.seaCells} sea cells are passable`);
  if (sea && n.farFieldBlocked !== n.farFieldCells) errors.push(`far-field corner: ${n.farFieldCells - n.farFieldBlocked} of ${n.farFieldCells} sea cells are passable`);
  if (!sea && n.seaBlocked) errors.push(`${n.seaBlocked} sea cells are blocked although the coastline was unavailable`);
  if (n.landBlocked) errors.push(`${n.landBlocked} of ${n.landCells} land cells are blocked`);
  if (n.lagoonBlocked !== n.lagoonCells) errors.push(`lagoon: ${n.lagoonCells - n.lagoonBlocked} of ${n.lagoonCells} cells are passable`);
  for (const [r, c] of COAST.river) if (!mask[r * W + c]) errors.push(`river cell [${r},${c}] is passable`);
  const [tr, tc] = [COAST.tunnelRiver[0][0], 60];
  if (mask[tr * W + tc]) errors.push(`tunnelled river cell [${tr},${tc}] is blocked`);
  return { errors, counts: n };
}
