// Vector network: GeoPackage read/write, input-dataset export/import,
// rasterisation, the Overpass and FlatGeobuf street pulls.
import "./dem.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { setGroupOpen, syncLoadedHighlights } from "./panel.js";
import { map } from "./map.js";
import { escapeHtml, state } from "./state.js";
import { cancelActiveCompute } from "./compute-source.js";
import { progress, progressBar, status } from "./dom.js";
import { FABDEM_ARCSEC, FABDEM_MAX_BYTES } from "./dem.js";
import { installBridgesFromWays } from "./bridges.js";
import { onNetworkCorridorsChanged } from "./water.js";
import { applyNetworkLinesOverlay } from "./network-view.js";
import { kpiInvalidate } from "./points.js";
import { writeRasterAsGeoTIFF } from "./geotiff.js";
import { WGS84_WKT } from "./bundle.js";

// ------- Vector network loader (GeoPackage) -------
// Reads a .gpkg via sql.js, finds the (first) geometry table, reprojects
// LineString features into the DEM CRS via proj4js, and rasterises them
// with Bresenham into a binary network mask. The mask is AND'd with the
// DEM mask before each compute so analysis is constrained to the lines.

let _sqlPromise = null;
function getSQL() {
  if (!_sqlPromise) {
    if (typeof initSqlJs !== "function") {
      return Promise.reject(new Error(t("status.sqljs_unavailable")));
    }
    // sql.js fetches sql-wasm.wasm from this CDN ON FIRST GeoPackage open. Like
    // the other CDN libs it is runtime-cached (sw.js), NOT precached — so
    // offline GeoPackage import requires opening a .gpkg at least once while
    // online (same caveat as DEMs). initSqlJs rejects below if it's missing.
    _sqlPromise = initSqlJs({
      locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`,
    }).catch((err) => { _sqlPromise = null; throw err; }); // let a later retry re-fetch
  }
  return _sqlPromise;
}

// ------- Group 0: input-dataset export / import -------
// Round-trips the four inputs in the SAME format on both ends: 1A DEM + 1C mask
// as GeoTIFF (reusing writeRasterAsGeoTIFF, georeferenced from state.dem), 1B
// network + 1D bridges as GeoPackage. The .gpkg WRITER below inverts
// parseGpkgGeom/parseWKB — a sql.js DB carrying the OGC metadata tables and one
// StandardGeoPackageBinary LineString blob per feature, all WGS84 (EPSG:4326), so
// loadVectorNetwork / parseGpkgGeom read them straight back.

function ioDownload(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// (WGS84_WKT — the EPSG:4326 definition gpkg_spatial_ref_sys needs so the reader's
// proj4 resolves srs_id 4326 — is declared near the GeoTIFF export below.)

// Encode one polyline ([[lat,lng],…]) as a StandardGeoPackageBinary LineString
// blob: 8-byte header (GP magic, version, flags=no-envelope/LE, srs_id) + WKB
// (LE byte order, type 2, vertex count, then [lng,lat] float64 pairs). The exact
// inverse of parseGpkgGeom + parseWKB; coords stay [x=lng, y=lat] (no swap).
function encodeGpkgLineString(latlngs, srsId) {
  const n = latlngs.length;
  const buf = new ArrayBuffer(8 + 9 + n * 16);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o++, 0x47); dv.setUint8(o++, 0x50);   // "GP"
  dv.setUint8(o++, 0x00);                           // version 0
  dv.setUint8(o++, 0x01);                           // flags: LE header, no envelope
  dv.setInt32(o, srsId, true); o += 4;              // srs_id (little-endian)
  dv.setUint8(o++, 0x01);                           // WKB byte order: little-endian
  dv.setUint32(o, 2, true); o += 4;                 // WKB type: LineString
  dv.setUint32(o, n, true); o += 4;                 // vertex count
  for (let i = 0; i < n; i++) {
    dv.setFloat64(o, latlngs[i][1], true); o += 8;  // X = lng
    dv.setFloat64(o, latlngs[i][0], true); o += 8;  // Y = lat
  }
  return new Uint8Array(buf);
}

// Build a GeoPackage (Uint8Array) of LineString features. `features` =
// [{ latlngs:[[lat,lng],…], attrs:{colName:value} }]; `attrCols` = [{name,type}].
async function buildGeoPackage(features, { tableName, attrCols = [] }) {
  const SQL = await getSQL();
  const db = new SQL.Database();
  const SRS = 4326;
  try {
    db.run("PRAGMA application_id = 1196444487;"); // 'GPKG' — flags the file as a GeoPackage
    db.run("PRAGMA user_version = 10401;");
    db.run("CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);");
    db.run("CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change TEXT NOT NULL, min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);");
    db.run("CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, PRIMARY KEY (table_name, column_name));");
    db.run("INSERT INTO gpkg_spatial_ref_sys VALUES ('Undefined cartesian SRS',-1,'NONE',-1,'undefined',''),('Undefined geographic SRS',0,'NONE',0,'undefined',''),('WGS 84 geodetic',4326,'EPSG',4326,?,'');", [WGS84_WKT]);
    const colDefs = attrCols.map((c) => `, "${c.name}" ${c.type || "TEXT"}`).join("");
    db.run(`CREATE TABLE "${tableName}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom BLOB${colDefs});`);
    db.run("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'LINESTRING', ?, 0, 0);", [tableName, SRS]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const cols = ["geom", ...attrCols.map((c) => `"${c.name}"`)].join(", ");
    const ph = ["?", ...attrCols.map(() => "?")].join(", ");
    const stmt = db.prepare(`INSERT INTO "${tableName}" (${cols}) VALUES (${ph});`);
    for (const f of features) {
      if (!f.latlngs || f.latlngs.length < 2) continue;
      for (const [lat, lng] of f.latlngs) {
        if (lng < minX) minX = lng; if (lng > maxX) maxX = lng;
        if (lat < minY) minY = lat; if (lat > maxY) maxY = lat;
      }
      const vals = [encodeGpkgLineString(f.latlngs, SRS),
        ...attrCols.map((c) => { const v = f.attrs ? f.attrs[c.name] : null; return v == null ? null : v; })];
      stmt.run(vals);
    }
    stmt.free();
    if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = 0; }
    db.run("INSERT INTO gpkg_contents (table_name, data_type, identifier, last_change, min_x, min_y, max_x, max_y, srs_id) VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?);",
      [tableName, tableName, new Date().toISOString(), minX, minY, maxX, maxY, SRS]);
    return db.export();
  } finally {
    db.close();
  }
}

// 1A — DEM raster → GeoTIFF.
export function exportDemTif() {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_dem"))}</span>`; return; }
  try {
    // Re-emit the source GDAL_NODATA tag so a re-imported dem.tif reconstructs
    // the same mask — without it, nodata cells (still holding the raw
    // sentinel in state.dem.height) round-trip as "valid" terrain. Also stamp
    // the cumulative pre-smoothing σ (v55): the exported surface IS the
    // smoothed one, and the tag stops loadDemFromArrayBuffer's auto rule from
    // smoothing it again on re-import.
    const extraMd = {};
    if (state.dem.nodata != null) extraMd.GDAL_NODATA = String(state.dem.nodata);
    if (state.dem.smoothCumSigmaM > 0) extraMd.ImageDescription = `simujaules:demSmoothSigmaM=${state.dem.smoothCumSigmaM}`;
    ioDownload(new Uint8Array(writeRasterAsGeoTIFF(state.dem.height, state.dem, "float32", Object.keys(extraMd).length ? extraMd : undefined)), "dem.tif", "image/tiff");
    status.textContent = t("io.exported", "dem.tif");
  } catch (e) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`; }
}

// 1C — impassable mask raster → GeoTIFF (DEM-aligned uint8, same as the bundle).
export function exportMaskTif() {
  if (!state.dem || !state.impassable) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_mask"))}</span>`; return; }
  try {
    ioDownload(new Uint8Array(writeRasterAsGeoTIFF(state.impassable, state.dem, "uint8")), "impassable_mask.tif", "image/tiff");
    status.textContent = t("io.exported", "impassable_mask.tif");
  } catch (e) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`; }
}

// 1B — vector network → GeoPackage. Carries the per-way {deck, layer} tags so the
// file is self-describing in a GIS (loadVectorNetwork doesn't read them back into
// networkLinesMeta yet — same limitation as any .gpkg network).
export async function exportNetworkGpkg() {
  if (!state.networkLines || !state.networkLines.length) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_network"))}</span>`; return; }
  try {
    const meta = state.networkLinesMeta;
    const features = state.networkLines.map((ll, i) => ({
      latlngs: ll,
      attrs: { deck: meta && meta[i] ? (meta[i].deck ? 1 : 0) : null, layer: meta && meta[i] ? meta[i].layer : null },
    }));
    const bytes = await buildGeoPackage(features, { tableName: "network", attrCols: [{ name: "deck", type: "INTEGER" }, { name: "layer", type: "INTEGER" }] });
    ioDownload(bytes, "network.gpkg", "application/geopackage+sqlite3");
    status.textContent = t("io.exported", "network.gpkg");
  } catch (e) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`; }
}

// 1D — bridges/portals → GeoPackage (LineStrings + kind/layer/name/eleA/eleB).
// Drawn portals are excluded (they persist through the config, like the bundle).
export async function exportBridgesGpkg() {
  const bridges = (state.bridges || []).filter((b) => !b.drawn);
  if (!bridges.length) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_bridges"))}</span>`; return; }
  try {
    const features = bridges.map((b) => ({
      latlngs: b.latlngs,
      attrs: { kind: b.kind || null, layer: b.layer ?? null, name: b.name || null, eleA: b.eleA ?? null, eleB: b.eleB ?? null },
    }));
    const bytes = await buildGeoPackage(features, { tableName: "bridges", attrCols: [
      { name: "kind", type: "TEXT" }, { name: "layer", type: "INTEGER" }, { name: "name", type: "TEXT" },
      { name: "eleA", type: "REAL" }, { name: "eleB", type: "REAL" }] });
    ioDownload(bytes, "bridges.gpkg", "application/geopackage+sqlite3");
    status.textContent = t("io.exported", "bridges.gpkg");
  } catch (e) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(e.message)}</span>`; }
}

// 1D import — read a bridges .gpkg (the inverse of exportBridgesGpkg) and feed it
// to installBridgesFromWays. Assumes WGS84 geometry (what we write); a geographic
// DEM is required for the lat/lng→cell abutment mapping.
export async function importBridgesGpkg(file) {
  if (!state.dem) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("io.no_dem_first"))}</span>`; return; }
  if (!state.dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${escapeHtml(t("bridges.need_geographic"))}</span>`; return; }
  const SQL = await getSQL();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  try {
    const gc = db.exec("SELECT table_name, column_name FROM gpkg_geometry_columns LIMIT 1");
    if (!gc.length) throw new Error(t("io.gpkg_invalid"));
    const tbl = gc[0].values[0][0], gcol = gc[0].values[0][1] || "geom";
    const info = db.exec(`PRAGMA table_info("${tbl}")`);
    const present = info.length ? info[0].values.map((r) => r[1]) : [];
    const extra = ["kind", "layer", "name", "eleA", "eleB"].filter((c) => present.includes(c));
    const sel = [`"${gcol}"`, ...extra.map((c) => `"${c}"`)].join(", ");
    const res = db.exec(`SELECT ${sel} FROM "${tbl}"`);
    const ways = [];
    if (res.length) {
      for (const row of res[0].values) {
        let lines = null;
        try { lines = parseGpkgGeom(row[0]); } catch { lines = null; }
        if (!lines) continue;
        const at = {}; extra.forEach((c, i) => { at[c] = row[1 + i]; });
        for (const coords of lines) {
          const latlngs = coords.map(([lng, lat]) => [lat, lng]);
          if (latlngs.length < 2) continue;
          ways.push({ latlngs, kind: at.kind || "bridge", layer: Number.isFinite(at.layer) ? at.layer : 0,
            name: at.name || null, eleA: Number.isFinite(at.eleA) ? at.eleA : null, eleB: Number.isFinite(at.eleB) ? at.eleB : null });
        }
      }
    }
    if (!ways.length) throw new Error(t("io.gpkg_no_lines"));
    installBridgesFromWays(ways, file.name);
  } finally {
    db.close();
  }
}

// Parse a GeoPackage StandardGeoPackageBinary blob into an array of
// [x, y] coordinates, or null when the geometry isn't a (Multi)LineString.
// Header layout per OGC GeoPackage 1.4 §2.1.3.
function parseGpkgGeom(blob) {
  if (!(blob instanceof Uint8Array) || blob.length < 8) return null;
  if (blob[0] !== 0x47 || blob[1] !== 0x50) return null; // "GP"
  const flags = blob[3];
  const envelopeType = (flags >> 1) & 0x07;
  const envBytes = [0, 32, 48, 48, 64, 0, 0, 0][envelopeType] || 0;
  const wkbStart = 8 + envBytes;
  if (blob.length < wkbStart + 9) return null;

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return parseWKB(view, wkbStart);
}

// Decode a WKB geometry-type word into the 2-D base type and the per-vertex
// byte stride. Handles both dimension encodings in the wild:
//   ISO/OGC: base + 1000·Z + 2000·M + 3000·ZM  (LineString Z = 1002 — what
//            QGIS writes into GeoPackages by default for 3-D sources)
//   EWKB:    flag bits 0x80000000 (Z) / 0x40000000 (M)
// The old code masked with `t & 0x0fff`, which left ISO-typed geometries
// (1002, 1005, …) unrecognised — 3-D .gpkg files silently rasterised to an
// empty network.
function wkbTypeInfo(t) {
  const code = t & 0x0fffffff;       // drop EWKB flag bits
  const base = code % 1000;          // ISO offsets: 1002 → 2, 3005 → 5
  const isoDim = Math.floor(code / 1000) | 0;
  const hasZ = (t & 0x80000000) !== 0 || isoDim === 1 || isoDim === 3;
  const hasM = (t & 0x40000000) !== 0 || isoDim === 2 || isoDim === 3;
  return { base, stride: 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0) };
}

// Every read is bounds-guarded against view.byteLength: a corrupt/truncated
// blob — or a header mis-aligned by an unrecognised GeoPackage envelope type
// — must return null (the caller skips that one feature) rather than throw a
// RangeError out of getFloat64/getUint32 that aborts the entire .gpkg load.
function parseWKB(view, off) {
  const len = view.byteLength;
  if (off + 5 > len) return null;
  const le = view.getUint8(off) === 1;
  off += 1;
  const t = view.getUint32(off, le);
  off += 4;
  const { base: baseType, stride } = wkbTypeInfo(t);

  if (baseType === 2) {
    // LineString
    if (off + 4 > len) return null;
    const n = view.getUint32(off, le); off += 4;
    if (off + n * stride > len) return null; // truncated / absurd vertex count
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = [view.getFloat64(off, le), view.getFloat64(off + 8, le)];
      off += stride;
    }
    return [out];
  }
  if (baseType === 5) {
    // MultiLineString — skip outer header per child too
    if (off + 4 > len) return null;
    const k = view.getUint32(off, le); off += 4;
    const lines = [];
    for (let j = 0; j < k; j++) {
      if (off + 5 > len) return null;
      const subLE = view.getUint8(off) === 1; off += 1;
      const subT = view.getUint32(off, subLE); off += 4;
      const { base: subBase, stride: subStride } = wkbTypeInfo(subT);
      if (subBase !== 2) return null;
      if (off + 4 > len) return null;
      const n = view.getUint32(off, subLE); off += 4;
      if (off + n * subStride > len) return null; // truncated / absurd
      const ln = new Array(n);
      for (let i = 0; i < n; i++) {
        ln[i] = [view.getFloat64(off, subLE), view.getFloat64(off + 8, subLE)];
        off += subStride;
      }
      lines.push(ln);
    }
    return lines;
  }
  return null;
}

// Bresenham 8-connected line draw onto a 1D row-major mask. Plots a
// "stamp" of (2*halfWidth + 1) cells for line widths > 1.
function rasterLine(r0, c0, r1, c1, mask, W, H, halfWidth) {
  const dr = Math.abs(r1 - r0);
  const dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dc - dr;
  let r = r0, c = c0;
  // Hard iteration cap. A line clipped to the grid plots at most ~(W+H) cells.
  // A wrong-CRS .gpkg can yield endpoints MILLIONS of cells apart (one far NW,
  // one far SE) that slip past the off-grid cull at the call sites; without a
  // cap this Bresenham walk runs for millions of steps on the main thread and
  // freezes the tab. Such a network rasterises to ~0 in-grid cells and is
  // rejected downstream, so bailing early only affects the pathological case.
  let guard = 2 * (W + H) + 4 * halfWidth + 16;
  while (guard-- > 0) {
    for (let pdr = -halfWidth; pdr <= halfWidth; pdr++) {
      const rr = r + pdr;
      if (rr < 0 || rr >= H) continue;
      const rowOff = rr * W;
      for (let pdc = -halfWidth; pdc <= halfWidth; pdc++) {
        const cc = c + pdc;
        if (cc < 0 || cc >= W) continue;
        mask[rowOff + cc] = 1;
      }
    }
    if (r === r1 && c === c1) break;
    const e2 = 2 * err;
    if (e2 > -dr) { err -= dr; c += sc; }
    if (e2 <  dc) { err += dc; r += sr; }
  }
}

export function readFileWithProgress(file, onFrac) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error("FileReader error"));
    fr.onprogress = (e) => {
      if (e.lengthComputable) onFrac(e.loaded / e.total);
    };
    fr.readAsArrayBuffer(file);
  });
}

export async function loadVectorNetwork(file) {
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`;
    return;
  }
  // state.dem is replaced wholesale on every DEM load, so object identity is
  // a correct epoch token: if it changes during this multi-second rasterise
  // (await points below), the mask we're building is sized to a DEM that no
  // longer exists — bail instead of installing it onto the new one.
  const demRef = state.dem;

  // In-progress status lives in the network section's own meta line — it's
  // contextual to where the user clicked, and the global `status` stays
  // free for messages from other parts of the app.
  const vecMeta = document.getElementById("vec-meta");
  const setVecStatus = (html) => { if (vecMeta) vecMeta.innerHTML = html; };

  // Reuse the compute progress bar. File-read phase fills 0–40 %, sql.js
  // init 40–50 %, rasterise 50–100 %.
  progress.classList.add("active");
  progressBar.style.width = "0%";
  // db is declared outside the try so the finally below can close it, but
  // only ever gets assigned INSIDE the try — so a failure in the file-read/
  // sql.js-init awaits (which run before it exists) still reaches the
  // finally and clears the progress bar instead of leaving it stuck active.
  let db = null;
  try {
    setVecStatus(t("status.vec_reading", escapeHtml(file.name), (file.size / 1024 / 1024).toFixed(0)));
    const buf = await readFileWithProgress(file, (frac) => {
      progressBar.style.width = `${(frac * 40).toFixed(1)}%`;
    });
    progressBar.style.width = "40%";

    setVecStatus(t("status.vec_init_sql"));
    const SQL = await getSQL();
    db = new SQL.Database(new Uint8Array(buf));
    progressBar.style.width = "50%";

    // Prefer a line-geometry layer — a multi-layer .gpkg (OSM extract with
    // landuse polygons + roads lines, a QGIS project export, …) whose FIRST
    // registered layer isn't lines would otherwise parse every geometry blob
    // to null (parseGpkgGeom only accepts (Multi)LineString) and fail with a
    // misleading "0 cells" error even though a usable layer exists. Fall
    // back to the unfiltered query for generic 'GEOMETRY'-typed or
    // single-layer files.
    let cont = db.exec(
      "SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns " +
      "WHERE upper(geometry_type_name) IN ('LINESTRING','MULTILINESTRING','MULTICURVE','CURVE') LIMIT 1",
    );
    if (!cont.length) cont = db.exec("SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns LIMIT 1");
    if (!cont.length) throw new Error(t("io.gpkg_invalid"));
    const tableName = cont[0].values[0][0];
    // Geometry column name from the metadata — QGIS/ogr2ogr default to
    // "geom", but "geometry"/"shape" exist in the wild; hardcoding "geom"
    // made those files fail to load.
    const geomCol   = cont[0].values[0][1] || "geom";
    // SQLite lets TEXT live in INTEGER columns, so a crafted .gpkg could
    // smuggle HTML through srs_id into the innerHTML sinks below (and into
    // the gpkg_spatial_ref_sys query). Coerce once at the source; the
    // 0 fallback means "undefined SRS" and keeps the isSrcWgs check working.
    const rawSrsId  = Number(cont[0].values[0][2]);
    const srsId     = Number.isFinite(rawSrsId) ? rawSrsId : 0;

    // Detect attribute columns we can flag bridges/tunnels with — OSM-export
    // schemas vary: some have dedicated bridge/tunnel/layer columns, others
    // pack them into an hstore `other_tags` string. We SELECT whichever exist
    // alongside the geometry so loadVectorNetwork can capture bridge candidates
    // for the 1d "extract from loaded network" feature, without a re-parse.
    let allCols = [];
    try {
      const ti = db.exec(`PRAGMA table_info("${tableName}")`);
      if (ti.length) allCols = ti[0].values.map((v) => String(v[1]));
    } catch {}
    const tagCols = ["bridge", "tunnel", "layer", "name", "other_tags"].filter((c) => allCols.includes(c));

    // Resolve source CRS for proj4. WGS84 is built in; everything else
    // uses the WKT/PROJ string from gpkg_spatial_ref_sys.
    const isSrcWgs = srsId === 4326 || srsId === 0 || srsId === -1;
    if (!isSrcWgs) {
      const srsRes = db.exec(
        `SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = ${srsId}`,
      );
      if (!srsRes.length || !srsRes[0].values[0][0]) {
        throw new Error(`Source SRS ${srsId} has no definition in gpkg_spatial_ref_sys`);
      }
      proj4.defs(`EPSG:${srsId}`, srsRes[0].values[0][0]);
    }

    // DEM bounds in source CRS for the rtree filter — keeps us from
    // burning every line in a country-scale .gpkg when the DEM is small.
    const { originX, originY, H, W, dx, dy } = state.dem;
    const south = originY - H * dy, north = originY;
    const west  = originX,         east  = originX + W * dx;
    let xmin, xmax, ymin, ymax;
    if (isSrcWgs) {
      xmin = west;  xmax = east;
      ymin = south; ymax = north;
    } else {
      const corners = [
        [west, south], [east, south], [east, north], [west, north],
      ].map(([x, y]) => proj4("EPSG:4326", `EPSG:${srsId}`, [x, y]));
      xmin = Math.min(...corners.map((p) => p[0]));
      xmax = Math.max(...corners.map((p) => p[0]));
      ymin = Math.min(...corners.map((p) => p[1]));
      ymax = Math.max(...corners.map((p) => p[1]));
    }

    // Try the rtree-filtered query first; fall back to a full scan if the
    // table isn't there.
    const rtree = `rtree_${tableName}_${geomCol}`;
    let stmt, totalFeatures = 0, useRtree = true;
    try {
      // Pre-count for the progress bar.
      const cnt = db.prepare(
        `SELECT COUNT(*) FROM "${rtree}" WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?`,
      );
      cnt.bind([xmax, xmin, ymax, ymin]);
      cnt.step();
      totalFeatures = cnt.get()[0] | 0;
      cnt.free();
      stmt = db.prepare(`
        SELECT t."${geomCol}"${tagCols.map((c) => `, t."${c}"`).join("")} FROM "${tableName}" t
        WHERE t.fid IN (
          SELECT id FROM "${rtree}"
          WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
        )
      `);
      stmt.bind([xmax, xmin, ymax, ymin]);
    } catch (e) {
      console.info("[gpkg] no rtree, full scan:", e.message);
      useRtree = false;
      try {
        const cnt = db.prepare(`SELECT COUNT(*) FROM "${tableName}"`);
        cnt.step();
        totalFeatures = cnt.get()[0] | 0;
        cnt.free();
      } catch {}
      stmt = db.prepare(`SELECT "${geomCol}"${tagCols.map((c) => `, "${c}"`).join("")} FROM "${tableName}"`);
    }
    // Geometry is row[0]; tag columns follow in tagCols order.
    const tagIdx = {}; tagCols.forEach((c, i) => { tagIdx[c] = i + 1; });

    const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
    const halfWidth = (lineWidth - 1) >> 1;
    const networkMask = new Uint8Array(W * H);

    const project = isSrcWgs ? (xy) => xy : (xy) => proj4(`EPSG:${srsId}`, "EPSG:4326", xy);

    let scanned = 0, rasterised = 0;
    // Collect WGS84 geometry for the optional vector rendering. Capped so a
    // monster network can't blow up memory / the Leaflet canvas — past the
    // cap we keep rasterising but stop storing, and disable the draw toggle.
    const VEC_RENDER_VERTEX_CAP = 2_000_000;
    let storedVertices = 0;
    let collected = [];
    // Bridge/tunnel ways extracted for the 1d "from loaded network" feature.
    const bridgeCandidates = [];
    const extractWayTags = (row) => {
      const get = (c) => (tagIdx[c] != null ? row[tagIdx[c]] : null);
      const ot = get("other_tags");
      const otv = (k) => { if (!ot) return null; const m = ot.match(new RegExp('"' + k + '"=>"([^"]*)"')); return m ? m[1] : null; };
      const bridge = get("bridge") || otv("bridge");
      const tunnel = get("tunnel") || otv("tunnel");
      const isBridge = (bridge && bridge !== "no") || tunnel === "yes";
      if (!isBridge) return { isBridge: false };
      const kind = tunnel === "yes" ? "tunnel" : "bridge";
      const layerRaw = get("layer") || otv("layer");
      return { isBridge: true, kind, layer: parseInt(layerRaw, 10) || (kind === "tunnel" ? -1 : 1), name: get("name") || otv("name") || null };
    };
    while (stmt.step()) {
      const row = stmt.get();
      const blob = row[0];
      scanned++;
      // parseGpkgGeom is bounds-guarded, but wrap defensively so any single
      // malformed geometry is skipped rather than aborting the whole load.
      let lines = null;
      try { lines = parseGpkgGeom(blob); } catch { lines = null; }
      if (!lines) continue;
      const tg = tagCols.length ? extractWayTags(row) : { isBridge: false };
      for (const coords of lines) {
        const keepRender = collected !== null && storedVertices < VEC_RENDER_VERTEX_CAP;
        // Build latlngs when rendering OR when this is a bridge/tunnel (we always
        // want a deck candidate's geometry, even past the render cap).
        const lineLatLngs = (keepRender || tg.isBridge) ? [] : null;
        let prevR = null, prevC = null;
        for (const xy of coords) {
          const [lng, lat] = project(xy);
          if (lineLatLngs) lineLatLngs.push([lat, lng]);
          if (keepRender) storedVertices++;
          const c = Math.floor((lng - originX) / dx);
          const r = Math.floor((originY - lat) / dy);
          if (prevR !== null) {
            // Clip wildly-out-of-bounds lines fast — we do per-pixel
            // bounds checks inside rasterLine but skipping segments that
            // are entirely outside saves a lot of pixel iterations.
            if (!(
              (prevR < 0 && r < 0) || (prevR >= H && r >= H) ||
              (prevC < 0 && c < 0) || (prevC >= W && c >= W)
            )) {
              rasterLine(prevR, prevC, r, c, networkMask, W, H, halfWidth);
            }
          }
          prevR = r; prevC = c;
        }
        if (lineLatLngs && lineLatLngs.length > 1) {
          if (keepRender) collected.push(lineLatLngs);
          if (tg.isBridge) bridgeCandidates.push({ latlngs: lineLatLngs, kind: tg.kind, layer: tg.layer, name: tg.name });
        }
        if (storedVertices >= VEC_RENDER_VERTEX_CAP && collected !== null) {
          console.warn(`[network] geometry over ${VEC_RENDER_VERTEX_CAP} vertices — vector rendering disabled, raster mask unaffected.`);
          collected = null;
        }
        rasterised++;
      }
      if (scanned % 2000 === 0) {
        const frac = totalFeatures > 0 ? scanned / totalFeatures : 0;
        progressBar.style.width = `${(50 + frac * 50).toFixed(1)}%`;
        setVecStatus(totalFeatures > 0
          ? t("status.vec_rasterising_of", scanned, totalFeatures, rasterised)
          : t("status.vec_rasterising_scan", scanned, rasterised));
        await new Promise((r) => setTimeout(r, 0));
        if (state.dem !== demRef) {
          status.textContent = t("status.load_superseded");
          return;
        }
      }
    }
    stmt.free();
    progressBar.style.width = "100%";

    let networkCells = 0;
    for (let i = 0; i < networkMask.length; i++) if (networkMask[i]) networkCells++;

    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }

    if (networkCells === 0) {
      // Rasterised to nothing — almost always a CRS or geometry-type
      // mismatch with the DEM. DON'T store the mask: an empty mask AND'd
      // with the DEM would make every click un-snappable and Compute
      // unusable. Say so loudly instead.
      document.getElementById("vec-meta").innerHTML =
        t("status.net_meta_zero", srsId, scanned, rasterised);
      document.getElementById("vec-meta").removeAttribute("data-i18n");
      status.innerHTML = `<span style="color:#ff6b6b">${t("status.net_zero_cells")}</span>`;
      return;
    }

    state.networkMask = networkMask;
    state.networkSrsId = srsId;
    state.networkFeatureCount = rasterised;
    document.getElementById("vec-meta").innerHTML =
      `EPSG:${srsId} · ` + t("status.net_meta_drawn", rasterised, networkCells.toLocaleString(), (100 * networkCells / (W * H)).toFixed(1));
    document.getElementById("vec-meta").removeAttribute("data-i18n");
    status.textContent = t("status.network_loaded");
    state.lastResult = null; // previous compute used the un-constrained mask
    kpiInvalidate();         // …including the accessibility matrix
    cancelActiveCompute();   // …and so would an in-flight one
    state.networkLines = collected;
    state.networkLinesMeta = null; // .gpkg graph-mode bridge flattening not wired (tags live per-feature, not per-kept-line)
    state.networkBridgeCandidates = bridgeCandidates.length ? bridgeCandidates : null;
    applyNetworkLinesOverlay();
    syncLoadedHighlights(); // light up group 1B
    setGroupOpen("impassable-group", true); // network loaded → next input step
    onNetworkCorridorsChanged(); // a new network may carve corridors over the mask
  } finally {
    if (db) db.close();
    progress.classList.remove("active");
  }
}

// Rasterise an array of WGS84 polylines ([[lat,lng], …] each) onto the DEM
// grid and install the result as the active network (mask, meta, rendering,
// compute invalidation). Shared tail for non-gpkg network sources (OSM).
function installNetworkFromLines(lines, srsId, sourceLabel, meta = null) {
  const { originX, originY, H, W, dx, dy } = state.dem;
  const lineWidth = Math.max(1, parseInt(document.getElementById("vec-width")?.value, 10) || 1);
  const halfWidth = (lineWidth - 1) >> 1;
  const networkMask = new Uint8Array(W * H);
  let rasterised = 0;
  for (const coords of lines) {
    let prevR = null, prevC = null;
    for (const [lat, lng] of coords) {
      const c = Math.floor((lng - originX) / dx);
      const r = Math.floor((originY - lat) / dy);
      if (prevR !== null && !(
        (prevR < 0 && r < 0) || (prevR >= H && r >= H) ||
        (prevC < 0 && c < 0) || (prevC >= W && c >= W)
      )) {
        rasterLine(prevR, prevC, r, c, networkMask, W, H, halfWidth);
      }
      prevR = r; prevC = c;
    }
    rasterised++;
  }

  let networkCells = 0;
  for (let i = 0; i < networkMask.length; i++) if (networkMask[i]) networkCells++;
  if (networkCells === 0) {
    status.innerHTML =
      `<span style="color:#ff6b6b">${t("status.net_zero_cells_src", escapeHtml(sourceLabel))}</span>`;
    return false;
  }

  state.networkMask = networkMask;
  state.networkSrsId = srsId;
  state.networkFeatureCount = rasterised;
  document.getElementById("vec-meta").innerHTML =
    `${escapeHtml(sourceLabel)} · ` + t("status.net_meta_drawn", rasterised, networkCells.toLocaleString(), (100 * networkCells / (W * H)).toFixed(1));
  document.getElementById("vec-meta").removeAttribute("data-i18n");
  status.textContent = t("status.network_loaded");
  state.lastResult = null;
  kpiInvalidate();
  cancelActiveCompute();
  // Keep geometry for the optional vector rendering, same cap as the gpkg path.
  // Keep per-way meta (bridge/tunnel/layer) aligned with the kept lines for
  // graph-mode bridge handling (Phase C).
  let vertices = 0;
  let kept = [];
  let keptMeta = meta ? [] : null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    vertices += ln.length;
    if (vertices > 2_000_000) { kept = null; keptMeta = null; break; }
    kept.push(ln);
    if (keptMeta) keptMeta.push(meta[i] || null);
  }
  state.networkLines = kept;
  state.networkLinesMeta = keptMeta;
  applyNetworkLinesOverlay();
  syncLoadedHighlights(); // light up group 1B
  setGroupOpen("impassable-group", true); // network loaded → next input step
  onNetworkCorridorsChanged(); // a new network may carve corridors over the mask
  return true;
}

// Pull the street network (highway=*) from OpenStreetMap via the Overpass
// API, over the intersection of the current map view and the DEM extent.
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export async function loadOsmNetwork() {
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`;
    return;
  }
  // OSM coords are lon/lat; the bbox intersection below only holds for a
  // geographic (EPSG:4326) DEM (mirrors the bridges/water OSM-pull guards).
  if (!state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_net_geographic")}</span>`;
    return;
  }
  // Epoch token: state.dem is replaced wholesale on every DEM load, so
  // identity is a correct guard against installing this pull onto a DEM
  // that changed while the Overpass fetch/parse was in flight.
  const demRef = state.dem;
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_no_intersect")}</span>`;
    return;
  }
  const osmBtn = document.getElementById("vec-osm");
  if (osmBtn) osmBtn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.osm_querying");
  try {
    // `out geom` inlines each way's coordinates — no separate node lookups.
    const query =
      `[out:json][timeout:90];way["highway"](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)});out geom;`;
    const resp = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(t("status.overpass_http", resp.status));
    progressBar.style.width = "60%";
    status.textContent = t("status.osm_parsing");
    const json = await resp.json();
    // A timed-out/OOM'd query still answers HTTP 200 with a `remark` field and
    // empty or PARTIAL elements — surface it as a failure BEFORE parsing any
    // elements, or a partial network pull installs an incomplete graph that
    // silently misses streets cut off by the timeout.
    if (json.remark) throw new Error(json.remark);
    const lines = [];
    const meta = []; // parallel { deck, layer } for graph-mode bridge handling
    const bridgeCandidates = []; // bridge/tunnel ways for the 1d "from network" feature
    for (const el of json.elements || []) {
      if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length > 1) {
        const latlngs = el.geometry.map((g) => [g.lat, g.lon]);
        lines.push(latlngs);
        const tg = el.tags || {};
        const deck = (tg.bridge && tg.bridge !== "no") || tg.tunnel === "yes";
        // 0-safe: an explicit layer=0 is a real value (|| would coerce it to
        // the default); missing/unparseable keeps the tunnel −1 / bridge 1.
        const layerParsed = parseInt(tg.layer, 10);
        const layer = Number.isFinite(layerParsed) ? layerParsed : (tg.tunnel === "yes" ? -1 : 1);
        meta.push(deck ? { deck: true, layer } : { deck: false, layer: 0 });
        if (deck) bridgeCandidates.push({ latlngs, kind: tg.tunnel === "yes" ? "tunnel" : "bridge", layer, name: tg["bridge:name"] || tg.name || null });
      }
    }
    if (!lines.length) throw new Error(t("status.osm_no_ways"));
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    state.networkBridgeCandidates = bridgeCandidates.length ? bridgeCandidates : null;
    progressBar.style.width = "80%";
    status.textContent = t("status.osm_rasterising", lines.length.toLocaleString());
    // Let the status paint before the synchronous rasterise.
    await new Promise((r) => setTimeout(r, 0));
    installNetworkFromLines(lines, 4326, "OSM highway=*", meta);
  } catch (err) {
    console.error("[osm]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (osmBtn) osmBtn.disabled = false;
  }
}

// Pull the same highway=* network from the South-America road FlatGeobuf
// (built by amora's build-viario.py from Geofabrik OSM, hosted on gs://telhas
// — CORS `*`). The FGB's packed Hilbert
// R-tree lets flatgeobuf.deserialize(url, rect) fetch ONLY the bytes inside
// the view∩DEM bbox via HTTP Range requests — no Overpass dependency, no
// server-side timeout, and bridge/tunnel/layer come as real columns (raw OSM
// values; normalized below exactly like the Overpass pull, so the two sources
// are interchangeable downstream). Reuses the flatgeobuf 3.36.0 the census
// sampling already loads, and the same installNetworkFromLines tail.
//
// SERVIDOS DIRETO DO GCS (storage.googleapis.com), NÃO do host bonito
// telhas.pedalhidrografi.co (v73): o proxy da Cloudflare não cacheia objetos
// acima de 512 MB (o viário tem 4,5 GB) e ESTRANGULA ranges grandes
// não-cacheáveis — medido: o MESMO range de 20 MB levou 92 s via telhas e
// 0,6 s direto do GCS (~150×; um pull de 0,2°×0,2° em SP caía de ~57 s pra
// segundos). O census .fgb sempre foi servido assim; o CSP (connect-src) já
// permite storage.googleapis.com, o CORS do bucket é `*` e Range é header
// CORS-safelisted (sem preflight). O telhas segue servindo os tiles XYZ
// (pequenos e cacheáveis — lá a Cloudflare ajuda). NÃO "arrumar" de volta
// pro host bonito sem re-medir.
// v81: os FGB saem do R2 (bucket `fabdem`, fabdem.pedalhidrografi.co/viario/),
// que NÃO cobra download — do GCS, cada byte que o navegador lia era egress
// pago. O R2 também passa pela Cloudflare, mas SEM o estrangulamento do telhas:
// medido 25/09/2026, o mesmo range de 20 MB do viário: 0,7–1,4 s pelo R2 vs
// 0,5–0,85 s direto do GCS vs até 60 s+ pelo telhas. Os > 500 MB estão com
// `Cache-Control: private` — senão a Cloudflare, a cada chave fria, ignora o
// Range e devolve 200 com o arquivo INTEIRO (1,7–4,5 GB). CORS do bucket: `*`
// (GET/HEAD, Range liberado); o CSP já permite fabdem.pedalhidrografi.co.
export const VIARIO_FGB_URL = "https://fabdem.pedalhidrografi.co/viario/south-america-viario.fgb";
export const WATER_AREAS_FGB_URL  = "https://fabdem.pedalhidrografi.co/viario/south-america-water-areas.fgb";
export const WATER_RIVERS_FGB_URL = "https://fabdem.pedalhidrografi.co/viario/south-america-water-rivers.fgb";
// Teto de janela dos pulls FGB = o MESMO teto do FABDEM (v71): a área em
// graus² que o cap do loader FABDEM permite (bytes ÷ 4 células ×
// (1″)² por célula — hoje 10°², via FABDEM_MAX_DEG2). Derivado das constantes do
// FABDEM de propósito — mudar o cap de lá move este junto, e qualquer janela
// que o FABDEM aceita os pulls de viário/água/pontes aceitam também (um único
// "aproxime o zoom" pra todo o fluxo). Antes: viário/pontes 0,25°² e água
// 1,0°², dois tetos à mão que já tinham divergido.
export const FGB_PULL_MAX_DEG2 = (FABDEM_MAX_BYTES / 4) * FABDEM_ARCSEC * FABDEM_ARCSEC;
const FGB_PULL_TIMEOUT_MS = 120_000;

// Stream de um FGB por bbox com timeout — a fetch órfã morre sozinha quando o
// generator é solto (deserialize não aceita AbortSignal). Uma cópia pros três
// pulls (viário, água, pontes).
export async function fgbStream(url, rect, onFeature) {
  await Promise.race([
    (async () => { for await (const f of flatgeobuf.deserialize(url, rect)) onFeature(f); })(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FGB_PULL_TIMEOUT_MS)),
  ]);
}

export async function loadFgbNetwork() {
  if (!state.dem) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.load_dem_first")}</span>`;
    return;
  }
  // FGB coords are lon/lat; the bbox intersection below only holds for a
  // geographic (EPSG:4326) DEM (same guard as the Overpass pull).
  if (!state.dem.isGeographic) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_net_geographic")}</span>`;
    return;
  }
  if (typeof flatgeobuf === "undefined") {
    status.innerHTML = `<span style="color:#ff6b6b">${t("census.lib_missing")}</span>`;
    return;
  }
  const demRef = state.dem;              // epoch token, same as loadOsmNetwork
  const { originX, originY, H, W, dx, dy } = state.dem;
  const b = map.getBounds();
  const south = Math.max(b.getSouth(), originY - H * dy);
  const north = Math.min(b.getNorth(), originY);
  const west  = Math.max(b.getWest(),  originX);
  const east  = Math.min(b.getEast(),  originX + W * dx);
  if (!(south < north && west < east)) {
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_no_intersect")}</span>`;
    return;
  }
  // Soft cap: an accidental continental-zoom pull would stream a huge share
  // of the file. Overpass self-limits via its server timeout; here we refuse
  // politely with the window size in km. The cap is the FABDEM window cap
  // (derived from its constants) — any window FABDEM accepts, this accepts.
  if ((east - west) * (north - south) > FGB_PULL_MAX_DEG2) {
    const kmX = (east - west) * 111.32 * Math.cos(((south + north) / 2) * Math.PI / 180);
    const kmY = (north - south) * 111.32;
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fgb_too_big", kmX.toFixed(0), kmY.toFixed(0))}</span>`;
    return;
  }
  const fgbBtn = document.getElementById("vec-fgb");
  if (fgbBtn) fgbBtn.disabled = true;
  progress.classList.add("active");
  progressBar.style.width = "20%";
  status.textContent = t("status.fgb_querying");
  try {
    const rect = { minX: west, minY: south, maxX: east, maxY: north };
    const lines = [];
    const meta = [];               // parallel { deck, layer }, as in the OSM pull
    const bridgeCandidates = [];
    const pushLine = (coords, p) => {
      if (!Array.isArray(coords) || coords.length < 2) return;
      const latlngs = coords.map((c) => [c[1], c[0]]);   // [lng,lat] → [lat,lng]
      lines.push(latlngs);
      // Same normalization as the Overpass pull (raw OSM values in columns).
      const deck = (p.bridge && p.bridge !== "no") || p.tunnel === "yes";
      const layerParsed = parseInt(p.layer, 10);
      const layer = Number.isFinite(layerParsed) ? layerParsed : (p.tunnel === "yes" ? -1 : 1);
      meta.push(deck ? { deck: true, layer } : { deck: false, layer: 0 });
      if (deck) bridgeCandidates.push({ latlngs, kind: p.tunnel === "yes" ? "tunnel" : "bridge", layer, name: null });
    };
    let n = 0;
    await fgbStream(VIARIO_FGB_URL, rect, (f) => {
      const g = f?.geometry;
      const p = f?.properties || {};
      if (g?.type === "LineString") pushLine(g.coordinates, p);
      else if (g?.type === "MultiLineString") for (const part of g.coordinates) pushLine(part, p);
      if (++n % 2048 === 0) {
        status.textContent = t("status.fgb_progress", n.toLocaleString());
        progressBar.style.width = `${Math.min(70, 20 + n / 400)}%`;
      }
    });
    if (!lines.length) throw new Error(t("status.fgb_no_ways"));
    if (state.dem !== demRef) {
      status.textContent = t("status.load_superseded");
      return;
    }
    state.networkBridgeCandidates = bridgeCandidates.length ? bridgeCandidates : null;
    progressBar.style.width = "80%";
    status.textContent = t("status.osm_rasterising", lines.length.toLocaleString());
    await new Promise((r) => setTimeout(r, 0));   // let the status paint
    installNetworkFromLines(lines, 4326, "FGB viário (América do Sul)", meta);
  } catch (err) {
    console.error("[fgb-net]", err);
    status.innerHTML = `<span style="color:#ff6b6b">${t("status.fgb_failed", escapeHtml(err.message))}</span>`;
  } finally {
    progress.classList.remove("active");
    if (fgbBtn) fgbBtn.disabled = false;
  }
}
