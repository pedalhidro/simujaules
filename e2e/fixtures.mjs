// Deterministic input fixtures for smoke.mjs (all generated in Node, no
// randomness, no clock): the synthetic DEM, a street-network GeoPackage, an
// impassable-mask GeoTIFF, two GPX tracks and a canned Overpass response.
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
