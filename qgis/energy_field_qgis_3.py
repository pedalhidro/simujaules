"""
QGIS Processing algorithm: Asymmetric energy field and route density.

Optional vector-line constraint: when a line layer is supplied, the search
is restricted to cells that lie on a rasterized version of those lines, so
routes follow streets / trails rather than crossing terrain freely.

Cost model per directed edge u -> v, dh = h_v - h_u:
    if dh >= 0:  cost = alpha * dist + beta * dh
    else:        cost = max(0, alpha * dist - eta * beta * |dh|)

Modes: From source / To destination / Round trip.

Network constraint notes:
  - The line layer is rasterized onto the DEM grid using GDAL's burn-in.
  - Cells touched by any line become the only passable cells.
  - The anchor point is snapped to the nearest network cell within a
    configurable tolerance.
  - 8-connected moves between network cells are still used; this means
    diagonals between two non-adjacent line cells are allowed if both their
    row and column neighbours are also on the network. In practice on a
    well-drawn line layer this is fine, but if you need strict topology use
    a coarser DEM (so each pixel is wider than the typical line gap) or
    pre-snap your line layer to a 4-connected raster.
  - Use a DEM resolution that is finer than the typical line spacing,
    otherwise multiple distinct streets may collapse into the same cell.

Install: Processing -> Toolbox -> Scripts -> "Add Script to Toolbox..."
"""

import gc
import heapq
import os
import tempfile
import numpy as np

from qgis.PyQt.QtCore import QCoreApplication
from qgis.core import (
    QgsProcessing,
    QgsProcessingAlgorithm,
    QgsProcessingParameterRasterLayer,
    QgsProcessingParameterFeatureSource,
    QgsProcessingParameterEnum,
    QgsProcessingParameterBoolean,
    QgsProcessingParameterNumber,
    QgsProcessingParameterExtent,
    QgsProcessingParameterRasterDestination,
    QgsProcessingException,
    QgsCoordinateTransform,
    QgsProject,
)
from osgeo import gdal, ogr


class EnergyAndPassesAlgorithm(QgsProcessingAlgorithm):
    DEM = "DEM"
    POINT = "POINT"
    NETWORK = "NETWORK"
    SNAP_PIXELS = "SNAP_PIXELS"
    MODE = "MODE"
    ALPHA = "ALPHA"
    BETA = "BETA"
    ETA = "ETA"
    EXTENT = "EXTENT"
    WANT_PASSES = "WANT_PASSES"
    WANT_SPLIT = "WANT_SPLIT"
    OUT_ENERGY = "OUT_ENERGY"
    OUT_PASSES = "OUT_PASSES"
    OUT_E_OUT = "OUT_E_OUT"
    OUT_E_IN = "OUT_E_IN"
    OUT_P_OUT = "OUT_P_OUT"
    OUT_P_IN = "OUT_P_IN"

    MODE_FROM = 0
    MODE_TO = 1
    MODE_ROUND = 2
    MODES = [
        "From source (energy/routes from point to every cell)",
        "To destination (energy/routes from every cell to point)",
        "Round trip (from point + back to point)",
    ]

    def tr(self, s):
        return QCoreApplication.translate("Processing", s)

    def createInstance(self):
        return EnergyAndPassesAlgorithm()

    def name(self):
        return "energyandpasses"

    def displayName(self):
        return self.tr("Asymmetric energy field & route density")

    def group(self):
        return self.tr("Terrain analysis")

    def groupId(self):
        return "terrainanalysis"

    def shortHelpString(self):
        return self.tr(
            "Minimum-energy field and (optional) route-density map between an "
            "anchor point P and every reachable cell of a DEM, under an "
            "asymmetric uphill/downhill cost model.\n\n"
            "Optional 'Network constraint' restricts pathfinding to cells "
            "covered by a vector line layer (e.g. a streets layer). The "
            "anchor is automatically snapped to the nearest network cell."
        )

    def initAlgorithm(self, config=None):
        self.addParameter(QgsProcessingParameterRasterLayer(
            self.DEM, self.tr("DEM (projected CRS)")))
        self.addParameter(QgsProcessingParameterFeatureSource(
            self.POINT, self.tr("Anchor point (first feature used)"),
            [QgsProcessing.TypeVectorPoint]))
        self.addParameter(QgsProcessingParameterFeatureSource(
            self.NETWORK,
            self.tr("Network constraint (optional line layer; when set, "
                    "routes follow these lines)"),
            [QgsProcessing.TypeVectorLine], optional=True))
        self.addParameter(QgsProcessingParameterNumber(
            self.SNAP_PIXELS,
            self.tr("Snap radius (pixels) for anchor onto network"),
            type=QgsProcessingParameterNumber.Integer,
            defaultValue=10, minValue=0))
        self.addParameter(QgsProcessingParameterEnum(
            self.MODE, self.tr("Mode"),
            options=self.MODES, defaultValue=0))
        self.addParameter(QgsProcessingParameterNumber(
            self.ALPHA, self.tr("alpha: cost per metre horizontal"),
            type=QgsProcessingParameterNumber.Double,
            defaultValue=0.008, minValue=0.0))
        self.addParameter(QgsProcessingParameterNumber(
            self.BETA, self.tr("beta: cost per metre uphill"),
            type=QgsProcessingParameterNumber.Double,
            defaultValue=1.0, minValue=0.0))
        self.addParameter(QgsProcessingParameterNumber(
            self.ETA, self.tr("eta: downhill recovery fraction (0..1)"),
            type=QgsProcessingParameterNumber.Double,
            defaultValue=0.1, minValue=0.0, maxValue=1.0))
        self.addParameter(QgsProcessingParameterExtent(
            self.EXTENT, self.tr("Extent (optional)"), optional=True))
        self.addParameter(QgsProcessingParameterBoolean(
            self.WANT_PASSES, self.tr("Compute route-density (passes count)"),
            defaultValue=True))
        self.addParameter(QgsProcessingParameterBoolean(
            self.WANT_SPLIT,
            self.tr("In round-trip mode, also output outgoing and incoming "
                    "components separately"),
            defaultValue=False))

        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_ENERGY, self.tr("Energy field")))
        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_PASSES, self.tr("Passes count"),
            optional=True, createByDefault=True))
        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_E_OUT, self.tr("Outgoing energy (P -> v)"),
            optional=True, createByDefault=False))
        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_E_IN, self.tr("Incoming energy (v -> P)"),
            optional=True, createByDefault=False))
        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_P_OUT, self.tr("Outgoing passes (P -> v)"),
            optional=True, createByDefault=False))
        self.addParameter(QgsProcessingParameterRasterDestination(
            self.OUT_P_IN, self.tr("Incoming passes (v -> P)"),
            optional=True, createByDefault=False))

    def processAlgorithm(self, parameters, context, feedback):
        dem_layer = self.parameterAsRasterLayer(parameters, self.DEM, context)
        point_source = self.parameterAsSource(parameters, self.POINT, context)
        network_source = self.parameterAsSource(parameters, self.NETWORK, context)
        snap_pixels = self.parameterAsInt(parameters, self.SNAP_PIXELS, context)
        mode = self.parameterAsEnum(parameters, self.MODE, context)
        alpha = self.parameterAsDouble(parameters, self.ALPHA, context)
        beta = self.parameterAsDouble(parameters, self.BETA, context)
        eta = self.parameterAsDouble(parameters, self.ETA, context)
        want_passes = self.parameterAsBoolean(parameters, self.WANT_PASSES, context)
        want_split = self.parameterAsBoolean(parameters, self.WANT_SPLIT, context)

        out_energy = self.parameterAsOutputLayer(parameters, self.OUT_ENERGY, context)
        out_passes = self.parameterAsOutputLayer(parameters, self.OUT_PASSES, context) \
            if want_passes else ""

        round_trip = (mode == self.MODE_ROUND)
        produce_split = round_trip and want_split

        out_e_out = self.parameterAsOutputLayer(parameters, self.OUT_E_OUT, context) \
            if produce_split else ""
        out_e_in = self.parameterAsOutputLayer(parameters, self.OUT_E_IN, context) \
            if produce_split else ""
        out_p_out = self.parameterAsOutputLayer(parameters, self.OUT_P_OUT, context) \
            if (produce_split and want_passes) else ""
        out_p_in = self.parameterAsOutputLayer(parameters, self.OUT_P_IN, context) \
            if (produce_split and want_passes) else ""

        if dem_layer is None:
            raise QgsProcessingException("Invalid DEM")
        if point_source is None or point_source.featureCount() == 0:
            raise QgsProcessingException("Point layer is empty")
        if not (0.0 <= eta <= 1.0):
            raise QgsProcessingException("eta must be in [0, 1]")
        if want_split and not round_trip:
            feedback.pushWarning(
                "Split-output toggle is on but mode is not round-trip — "
                "split rasters will not be produced."
            )

        dem_crs = dem_layer.crs()
        if dem_crs.isGeographic():
            feedback.pushWarning(
                "DEM CRS is geographic. Reproject to a projected CRS for "
                "meaningful units."
            )

        extent_param = self.parameterAsExtent(parameters, self.EXTENT, context, crs=dem_crs)
        full_extent = dem_layer.extent()
        extent = extent_param if not extent_param.isNull() else full_extent
        extent = extent.intersect(full_extent)
        if extent.isEmpty():
            raise QgsProcessingException("Requested extent does not overlap the DEM")

        # Read DEM window
        ds = gdal.Open(dem_layer.source())
        if ds is None:
            raise QgsProcessingException("Could not open DEM via GDAL")
        gt = ds.GetGeoTransform()
        px_w, px_h = abs(gt[1]), abs(gt[5])

        col_min = int(max(0, np.floor((extent.xMinimum() - gt[0]) / gt[1])))
        col_max = int(min(ds.RasterXSize, np.ceil((extent.xMaximum() - gt[0]) / gt[1])))
        row_min = int(max(0, np.floor((extent.yMaximum() - gt[3]) / gt[5])))
        row_max = int(min(ds.RasterYSize, np.ceil((extent.yMinimum() - gt[3]) / gt[5])))
        win_w, win_h = col_max - col_min, row_max - row_min
        if win_w <= 0 or win_h <= 0:
            raise QgsProcessingException("Empty read window")

        band = ds.GetRasterBand(1)
        nodata = band.GetNoDataValue()
        height = band.ReadAsArray(col_min, row_min, win_w, win_h).astype(np.float32)
        mask = np.isfinite(height)
        if nodata is not None:
            mask &= (height != np.float32(nodata))
        height = np.where(mask, height, np.float32(0.0))

        sub_ox = gt[0] + col_min * gt[1]
        sub_oy = gt[3] + row_min * gt[5]
        sub_gt = (sub_ox, gt[1], 0.0, sub_oy, 0.0, gt[5])
        projection = ds.GetProjection()
        ds = None

        # If a network is supplied, rasterize it and AND with the DEM mask
        if network_source is not None:
            feedback.pushInfo("Rasterizing network constraint ...")
            network_mask = self._rasterize_network(
                network_source, dem_crs,
                win_w, win_h, sub_gt, projection, feedback
            )
            if not network_mask.any():
                raise QgsProcessingException(
                    "Network rasterized to zero cells. Is the line layer "
                    "within the DEM extent?"
                )
            n_net = int(network_mask.sum())
            n_dem = int(mask.sum())
            mask &= network_mask
            n_kept = int(mask.sum())
            feedback.pushInfo(
                f"Network: {n_net} cells; intersection with DEM: {n_kept}"
            )
            del network_mask
            gc.collect()
            if n_kept == 0:
                raise QgsProcessingException(
                    "Network does not overlap any valid DEM cells."
                )

        # Resolve anchor point
        pt_crs = point_source.sourceCrs()
        xform = QgsCoordinateTransform(pt_crs, dem_crs, QgsProject.instance())
        feat = next(point_source.getFeatures())
        pt = feat.geometry().asPoint()
        pt_dem = xform.transform(pt)

        seed_col = int((pt_dem.x() - sub_ox) / gt[1])
        seed_row = int((pt_dem.y() - sub_oy) / gt[5])
        if not (0 <= seed_row < win_h and 0 <= seed_col < win_w):
            raise QgsProcessingException(
                f"Point outside DEM window (pixel {seed_row},{seed_col}; "
                f"size {win_h}x{win_w})"
            )

        # Snap the anchor to nearest valid (post-network) cell
        if not mask[seed_row, seed_col]:
            snapped = self._snap_to_mask(seed_row, seed_col, mask, snap_pixels)
            if snapped is None:
                hint = " (try increasing the snap radius)" if network_source is not None else ""
                raise QgsProcessingException(
                    f"Anchor point falls on an invalid cell and no valid cell "
                    f"was found within {snap_pixels} pixels{hint}"
                )
            feedback.pushInfo(
                f"Anchor snapped from ({seed_row},{seed_col}) to {snapped}"
            )
            seed_row, seed_col = snapped

        feedback.pushInfo(f"Mode: {self.MODES[mode]}")
        feedback.pushInfo(f"Compute passes count: {want_passes}")
        if round_trip:
            feedback.pushInfo(f"Output split components: {want_split}")
        feedback.pushInfo(f"Window {win_h}x{win_w}, cell {px_w:.3f}x{px_h:.3f}")
        feedback.pushInfo(
            f"Anchor pixel ({seed_row},{seed_col}) "
            f"elev {height[seed_row, seed_col]:.2f}"
        )

        results = {}
        if mode != self.MODE_ROUND:
            E, P = self._run_dijkstra(
                height, (seed_row, seed_col),
                alpha=alpha, beta=beta, eta=eta,
                dx=px_w, dy=px_h, mask=mask,
                reverse=(mode == self.MODE_TO),
                want_passes=want_passes, feedback=feedback,
            )
            self._write_float(out_energy, E, mask, win_w, win_h, sub_gt, projection)
            results[self.OUT_ENERGY] = out_energy
            feedback.pushInfo(f"Energy: max {self._max_finite(E, mask):.3g}")
            del E
            if want_passes and P is not None and out_passes:
                self._write_int(out_passes, P, mask, win_w, win_h, sub_gt, projection)
                results[self.OUT_PASSES] = out_passes
                feedback.pushInfo(f"Passes: max {int(P[mask].max())}")
            del P
            gc.collect()
        else:
            feedback.pushInfo("Computing outbound (P -> v) ...")
            E_out, P_out = self._run_dijkstra(
                height, (seed_row, seed_col),
                alpha=alpha, beta=beta, eta=eta,
                dx=px_w, dy=px_h, mask=mask,
                reverse=False, want_passes=want_passes, feedback=feedback,
            )
            if feedback.isCanceled():
                return {}
            gc.collect()

            feedback.pushInfo("Computing return (v -> P) ...")
            E_in, P_in = self._run_dijkstra(
                height, (seed_row, seed_col),
                alpha=alpha, beta=beta, eta=eta,
                dx=px_w, dy=px_h, mask=mask,
                reverse=True, want_passes=want_passes, feedback=feedback,
            )
            if feedback.isCanceled():
                return {}

            if produce_split:
                self._write_float(out_e_out, E_out, mask, win_w, win_h, sub_gt, projection)
                results[self.OUT_E_OUT] = out_e_out
                self._write_float(out_e_in, E_in, mask, win_w, win_h, sub_gt, projection)
                results[self.OUT_E_IN] = out_e_in
                if want_passes and P_out is not None and P_in is not None:
                    self._write_int(out_p_out, P_out, mask, win_w, win_h, sub_gt, projection)
                    results[self.OUT_P_OUT] = out_p_out
                    self._write_int(out_p_in, P_in, mask, win_w, win_h, sub_gt, projection)
                    results[self.OUT_P_IN] = out_p_in

            E_out += E_in
            del E_in
            gc.collect()
            self._write_float(out_energy, E_out, mask, win_w, win_h, sub_gt, projection)
            results[self.OUT_ENERGY] = out_energy
            feedback.pushInfo(f"Energy: max {self._max_finite(E_out, mask):.3g}")
            del E_out
            gc.collect()

            if want_passes and P_out is not None and P_in is not None and out_passes:
                P_out += P_in
                del P_in
                gc.collect()
                self._write_int(out_passes, P_out, mask, win_w, win_h, sub_gt, projection)
                results[self.OUT_PASSES] = out_passes
                feedback.pushInfo(f"Passes: max {int(P_out[mask].max())}")
                del P_out
                gc.collect()
            else:
                if P_out is not None:
                    del P_out
                if P_in is not None:
                    del P_in
                gc.collect()

        del height, mask
        gc.collect()
        return results

    # ---------- helpers ----------

    @staticmethod
    def _rasterize_network(network_source, dem_crs, w, h, gt, proj, feedback):
        """Burn the lines from network_source onto a w x h boolean mask
        aligned to (gt, proj)."""
        # In-memory OGR copy of the line layer, reprojected into dem_crs
        mem_drv = ogr.GetDriverByName("Memory")
        mem_ds = mem_drv.CreateDataSource("nw_mem")
        srs = osr_from_proj(proj)
        mem_layer = mem_ds.CreateLayer("nw", srs=srs, geom_type=ogr.wkbLineString)
        layer_def = mem_layer.GetLayerDefn()

        xform = QgsCoordinateTransform(network_source.sourceCrs(), dem_crs,
                                       QgsProject.instance())
        n_in = 0
        for f in network_source.getFeatures():
            geom = f.geometry()
            if geom is None or geom.isEmpty():
                continue
            geom2 = QgsGeometry(geom)
            if geom2.transform(xform) != 0:
                continue
            wkb = bytes(geom2.asWkb())
            ogr_geom = ogr.CreateGeometryFromWkb(wkb)
            if ogr_geom is None:
                continue
            ogr_feat = ogr.Feature(layer_def)
            ogr_feat.SetGeometry(ogr_geom)
            mem_layer.CreateFeature(ogr_feat)
            ogr_feat = None
            n_in += 1
        feedback.pushInfo(f"Burning {n_in} line features ...")

        # Create an in-memory raster and burn lines onto it
        ras_drv = gdal.GetDriverByName("MEM")
        ras = ras_drv.Create("", w, h, 1, gdal.GDT_Byte)
        ras.SetGeoTransform(gt)
        ras.SetProjection(proj)
        ras.GetRasterBand(1).Fill(0)
        gdal.RasterizeLayer(ras, [1], mem_layer, burn_values=[1],
                            options=["ALL_TOUCHED=TRUE"])
        arr = ras.GetRasterBand(1).ReadAsArray()
        ras = None
        mem_ds = None
        return arr.astype(bool)

    @staticmethod
    def _snap_to_mask(r0, c0, mask, max_pixels):
        """Find nearest True cell in `mask` within Chebyshev distance
        max_pixels of (r0, c0). Returns (r, c) or None."""
        if max_pixels <= 0:
            return None
        H, W = mask.shape
        for radius in range(1, max_pixels + 1):
            r_lo, r_hi = max(0, r0 - radius), min(H, r0 + radius + 1)
            c_lo, c_hi = max(0, c0 - radius), min(W, c0 + radius + 1)
            sub = mask[r_lo:r_hi, c_lo:c_hi]
            if not sub.any():
                continue
            rs, cs = np.where(sub)
            # absolute pixel coords
            rs += r_lo
            cs += c_lo
            # closest by Euclidean within the searched box
            d2 = (rs - r0) ** 2 + (cs - c0) ** 2
            i = int(np.argmin(d2))
            return int(rs[i]), int(cs[i])
        return None

    @staticmethod
    def _max_finite(arr, mask):
        valid = np.isfinite(arr) & mask
        return float(arr[valid].max()) if valid.any() else float("nan")

    @staticmethod
    def _write_float(path, arr, mask, w, h, gt, proj):
        if not path:
            return
        nd = -9999.0
        out = np.where(np.isfinite(arr) & mask, arr, np.float32(nd)).astype(np.float32)
        ds = gdal.GetDriverByName("GTiff").Create(
            path, w, h, 1, gdal.GDT_Float32,
            options=["COMPRESS=DEFLATE", "TILED=YES"])
        ds.SetGeoTransform(gt)
        ds.SetProjection(proj)
        b = ds.GetRasterBand(1)
        b.SetNoDataValue(nd)
        b.WriteArray(out)
        b.FlushCache()
        ds = None
        del out

    @staticmethod
    def _write_int(path, arr, mask, w, h, gt, proj):
        if not path:
            return
        nd = -1
        out = np.where(mask, arr, nd).astype(np.int32)
        ds = gdal.GetDriverByName("GTiff").Create(
            path, w, h, 1, gdal.GDT_Int32,
            options=["COMPRESS=DEFLATE", "TILED=YES"])
        ds.SetGeoTransform(gt)
        ds.SetProjection(proj)
        b = ds.GetRasterBand(1)
        b.SetNoDataValue(nd)
        b.WriteArray(out)
        b.FlushCache()
        ds = None
        del out

    @staticmethod
    def _run_dijkstra(height, seed, alpha, beta, eta, dx, dy, mask,
                      reverse, want_passes, feedback):
        H, W = height.shape
        N = H * W
        diag = float(np.hypot(dx, dy))
        MOVES = [(-1, -1, diag), (-1, 0, dy), (-1, 1, diag),
                 ( 0, -1, dx),                ( 0, 1, dx),
                 ( 1, -1, diag), ( 1, 0, dy), ( 1, 1, diag)]

        sr, sc = seed
        seed_flat = sr * W + sc
        E = np.full(N, np.float32(np.inf), dtype=np.float32)
        E[seed_flat] = np.float32(0.0)
        heap = [(0.0, sr, sc)]

        if want_passes:
            parents = np.full(N, -1, dtype=np.int32)
            settled = np.zeros(N, dtype=bool)
            order = np.empty(N, dtype=np.int32)
            k = 0

        total = int(mask.sum())
        progressed = 0
        last_report = 0

        while heap:
            if feedback.isCanceled():
                break
            g, r, c = heapq.heappop(heap)
            flat = r * W + c
            if want_passes:
                if settled[flat]:
                    continue
                settled[flat] = True
                order[k] = flat
                k += 1
                progressed = k
            else:
                if g > E[flat]:
                    continue
                progressed += 1
            if progressed - last_report > max(1000, total // 100):
                feedback.setProgress(int(100 * progressed / max(total, 1)))
                last_report = progressed

            h_here = height[r, c]
            for dr, dc, dist in MOVES:
                nr = r + dr
                nc = c + dc
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                if not mask[nr, nc]:
                    continue
                n_flat = nr * W + nc
                if want_passes and settled[n_flat]:
                    continue

                h_nbr = height[nr, nc]
                if reverse:
                    dh = h_here - h_nbr
                else:
                    dh = h_nbr - h_here

                if dh >= 0.0:
                    edge = alpha * dist + beta * dh
                else:
                    edge = alpha * dist - eta * beta * (-dh)
                    if edge < 0.0:
                        edge = 0.0

                tentative = g + edge
                if tentative < E[n_flat]:
                    E[n_flat] = tentative
                    if want_passes:
                        parents[n_flat] = flat
                    heapq.heappush(heap, (tentative, nr, nc))

        del heap
        E_2d = E.reshape(H, W)
        if not want_passes:
            return E_2d, None

        subtree = np.zeros(N, dtype=np.int32)
        for j in range(k):
            subtree[order[j]] = 1
        for j in range(k - 1, -1, -1):
            idx = order[j]
            p = parents[idx]
            if p >= 0:
                subtree[p] += subtree[idx]
        del parents, settled, order
        gc.collect()
        return E_2d, subtree.reshape(H, W)


# Local imports so module load doesn't fail if QGIS load order is funky
from qgis.core import QgsGeometry  # noqa: E402


def osr_from_proj(proj_wkt):
    """Build an OSR SpatialReference from a WKT string."""
    from osgeo import osr
    srs = osr.SpatialReference()
    srs.ImportFromWkt(proj_wkt)
    return srs
