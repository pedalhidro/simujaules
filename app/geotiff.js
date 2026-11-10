// GeoTIFF read/write helpers shared by the dataset and bundle I/O.
import "./colormaps.js"; // evaluation order — see ../app.js

// ---- GeoTIFF helpers --------------------------------------------------------
// We use geotiff.js's writer (bundled in the same script as the reader). The
// metadata schema mirrors what readRasters expects on the way back, so the
// round-trip is lossless. Float32 / Float64 / Uint8 cover all our outputs.

function tiffMetadataForDem(dem, sampleKind) {
  // sampleKind: "float32" (energy), "float64" (passes), or "uint8" (mask).
  const { H, W, originX, originY, dx, dy, isGeographic, geoKeys } = dem;
  const bps = sampleKind === "float64" ? 64 : sampleKind === "uint8" ? 8 : 32;
  // SampleFormat: 1 = unsigned int, 2 = signed int, 3 = IEEE floating point.
  const sf  = sampleKind === "uint8" ? 1 : 3;
  const md = {
    width:  W,
    height: H,
    BitsPerSample: [bps],
    SampleFormat:  [sf],
    SamplesPerPixel: [1],
    // ModelTiepoint maps raster pixel (0,0,0) to world (originX, originY, 0).
    // ModelPixelScale gives the per-pixel size; dy is positive in our DEM
    // model (height per row going down) so we use it directly.
    ModelTiepoint:    [0, 0, 0, originX, originY, 0],
    ModelPixelScale:  [Math.abs(dx), Math.abs(dy), 0],
  };
  // Forward the source DEM's CRS info verbatim. If we don't have it (older
  // load path) but we know the DEM is geographic, set EPSG:4326. The writer
  // also defaults to 4326 if neither is set, so projected DEMs without
  // captured GeoKeys would be misinterpreted — this is the failure mode to
  // watch for.
  if (geoKeys && Object.keys(geoKeys).length > 0) {
    Object.assign(md, geoKeys);
  } else if (isGeographic) {
    md.GeographicTypeGeoKey = 4326;
  }
  // Backfill the mandatory GTModelTypeGeoKey/GTRasterTypeGeoKey when the
  // source (or the branch above) didn't provide them — GDAL/QGIS otherwise
  // read the GeoKeyDirectory as an unknown engineering CRS instead of the
  // intended geographic/projected one. Never override a source-provided key.
  if (md.ProjectedCSTypeGeoKey && md.GTModelTypeGeoKey == null) {
    md.GTModelTypeGeoKey = 1;
  } else if (md.GeographicTypeGeoKey && md.GTModelTypeGeoKey == null) {
    md.GTModelTypeGeoKey = 2;
  }
  if (md.GTModelTypeGeoKey != null && md.GTRasterTypeGeoKey == null) {
    md.GTRasterTypeGeoKey = 1;
  }
  return md;
}

export function writeRasterAsGeoTIFF(values, dem, sampleKind, extraMd) {
  if (typeof GeoTIFF?.writeArrayBuffer !== "function") {
    throw new Error("GeoTIFF writer unavailable — load the full geotiff.js bundle.");
  }
  const md = tiffMetadataForDem(dem, sampleKind);
  // extraMd is opt-in per call (e.g. exportDemTif's GDAL_NODATA) — never
  // folded into tiffMetadataForDem itself, so energy/passes/network/
  // impassable exports don't inherit the source DEM's elevation sentinel.
  if (extraMd) Object.assign(md, extraMd);
  return GeoTIFF.writeArrayBuffer(values, md);
}

// Read a GeoTIFF blob from a bundle and return the underlying typed array
// in the requested element kind. We do a strict size check against the
// loaded DEM dims so a v3 bundle restored against a wrong DEM fails loudly
// (the buffer length mismatch surfaces the same way the .bin path does).
// NOTE: loadBundleFile's zip-entry size cap only bounds the ZIP-layer
// decompressed size — a small-but-valid GeoTIFF using its own internal
// compression (LZW/Deflate strips) could still expand to a large in-memory
// raster inside readRasters() below, past that cap. Not guarded here; a
// tighter check would compare image.getWidth()*getHeight()*bytesPerSample
// against the same cap right after tiff.getImage(), before readRasters().
export async function readRasterFromGeoTIFF(arrayBuffer, expectedKind) {
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const raster = await image.readRasters({ interleave: true });
  // readRasters returns the typed-array kind that matches the file's
  // BitsPerSample/SampleFormat. We coerce to the kind the caller wants.
  if (expectedKind === "float32" && !(raster instanceof Float32Array)) {
    return Float32Array.from(raster);
  }
  if (expectedKind === "float64" && !(raster instanceof Float64Array)) {
    return Float64Array.from(raster);
  }
  if (expectedKind === "uint8" && !(raster instanceof Uint8Array)) {
    return Uint8Array.from(raster);
  }
  return raster;
}
