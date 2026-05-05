"""
QGIS Processing algorithm: Top-N energy-optimal routes between two points.

Computes N spatially distinct minimum-energy paths from a source point to a
destination point on a DEM, under the asymmetric uphill/downhill cost model.

Method: iterative penalization. Find the optimal route; multiply the cost of
its cells by a penalty factor; find the next optimal route; repeat. Each new
route is forced to deviate where prior routes already passed, so the output
is a set of *visually distinct* alternatives rather than near-twin paths.

Cost model per directed edge u -> v, with dh = h_v - h_u:
    if dh >= 0:  cost = alpha * dist + beta * dh
    else:        cost = max(0, alpha * dist - eta * beta * |dh|)

A penalty factor `penalty` (>= 1.0) is multiplied into the *baseline* term
(alpha * dist) at cells already used by previous routes. The gravitational
component is left unpenalized, since you can't avoid the underlying climb.

Outputs:
  - A line vector with N features, one per route, attributed with route
    index, total energy, total length, and number of shared cells with prior
    routes.

Install: Processing -> Toolbox -> Scripts -> "Add Script to Toolbox..."
"""

import heapq
import numpy as np

from qgis.PyQt.QtCore import QCoreApplication, QVariant
from qgis.core import (
    QgsProcessing,
    QgsProcessingAlgorithm,
    QgsProcessingParameterRasterLayer,
    QgsProcessingParameterFeatureSource,
    QgsProcessingParameterNumber,
    QgsProcessingParameterExtent,
    QgsProcessingParameterFeatureSink,
    QgsProcessingException,
    QgsCoordinateTransform,
    QgsProject,
    QgsFeature,
    QgsFields,
    QgsField,
    QgsGeometry,
    QgsPointXY,
    QgsWkbTypes,
)
from osgeo import gdal


class TopNRoutesAlgorithm(QgsProcessingAlgorithm):
    DEM = "DEM"
    SOURCE_PT = "SOURCE_PT"
    DEST_PT = "DEST_PT"
    N_ROUTES = "N_ROUTES"
    PENALTY = "PENALTY"
    ALPHA = "ALPHA"
    BETA = "BETA"
    ETA = "ETA"
    EXTENT = "EXTENT"
    OUTPUT = "OUTPUT"

    def tr(self, s):
        return QCoreApplication.translate("Processing", s)

    def createInstance(self):
        return TopNRoutesAlgorithm()

    def name(self):
        return "topnroutes"

    def displayName(self):
        return self.tr("Top-N energy-optimal routes")

    def group(self):
        return self.tr("Terrain analysis")

    def groupId(self):
        return "terrainanalysis"

    def shortHelpString(self):
        return self.tr(
            "Computes the N cheapest spatially-distinct energy-optimal routes "
            "between a source and a destination point on a DEM.\n\n"
            "After each route is found, the baseline (horizontal) cost of its "
            "cells is multiplied by `penalty` so subsequent searches deviate. "
            "Higher penalty -> more spatially distinct alternatives but each "
            "extra route costs more energy.\n\n"
            "Cost per directed edge u -> v (dh = h_v - h_u):\n"
            "  uphill:   cost = alpha * dist + beta * dh\n"
            "  downhill: cost = max(0, alpha * dist - eta * beta * |dh|)\n\n"
            "Output is a line layer with one feature per route, attributed "
            "with route index, total energy, length, and shared-cell count."
        )

    def initAlgorithm(self, config=None):
        self.addParameter(QgsProcessingParameterRasterLayer(
            self.DEM, self.tr("DEM (projected CRS)")))
        self.addParameter(QgsProcessingParameterFeatureSource(
            self.SOURCE_PT, self.tr("Source point"),
            [QgsProcessing.TypeVectorPoint]))
        self.addParameter(QgsProcessingParameterFeatureSource(
            self.DEST_PT, self.tr("Destination point"),
            [QgsProcessing.TypeVectorPoint]))
        self.addParameter(QgsProcessingParameterNumber(
            self.N_ROUTES, self.tr("Number of routes (N)"),
            type=QgsProcessingParameterNumber.Integer,
            defaultValue=3, minValue=1, maxValue=20))
        self.addParameter(QgsProcessingParameterNumber(
            self.PENALTY, self.tr("Penalty factor for re-used cells (>= 1)"),
            type=QgsProcessingParameterNumber.Double,
            defaultValue=2.0, minValue=1.0))
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
        self.addParameter(QgsProcessingParameterFeatureSink(
            self.OUTPUT, self.tr("Routes"), QgsProcessing.TypeVectorLine))

    def processAlgorithm(self, parameters, context, feedback):
        dem_layer = self.parameterAsRasterLayer(parameters, self.DEM, context)
        src_source = self.parameterAsSource(parameters, self.SOURCE_PT, context)
        dst_source = self.parameterAsSource(parameters, self.DEST_PT, context)
        n_routes = self.parameterAsInt(parameters, self.N_ROUTES, context)
        penalty = self.parameterAsDouble(parameters, self.PENALTY, context)
        alpha = self.parameterAsDouble(parameters, self.ALPHA, context)
        beta = self.parameterAsDouble(parameters, self.BETA, context)
        eta = self.parameterAsDouble(parameters, self.ETA, context)

        # Validation
        if dem_layer is None:
            raise QgsProcessingException("Invalid DEM")
        for src, label in ((src_source, "Source"), (dst_source, "Destination")):
            if src is None or src.featureCount() == 0:
                raise QgsProcessingException(f"{label} point layer is empty")
        if not (0.0 <= eta <= 1.0):
            raise QgsProcessingException("eta must be in [0, 1]")
        if penalty < 1.0:
            raise QgsProcessingException("penalty must be >= 1.0")

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
        ds = None

        # Resolve source / destination cells
        def resolve(src, label):
            xform = QgsCoordinateTransform(src.sourceCrs(), dem_crs, QgsProject.instance())
            feat = next(src.getFeatures())
            pt = xform.transform(feat.geometry().asPoint())
            col = int((pt.x() - sub_ox) / gt[1])
            row = int((pt.y() - sub_oy) / gt[5])
            if not (0 <= row < win_h and 0 <= col < win_w):
                raise QgsProcessingException(
                    f"{label} point falls outside the DEM window "
                    f"(pixel {row},{col}; size {win_h}x{win_w})"
                )
            if not mask[row, col]:
                raise QgsProcessingException(
                    f"{label} point falls on a nodata cell"
                )
            return (row, col)

        s = resolve(src_source, "Source")
        d = resolve(dst_source, "Destination")
        if s == d:
            raise QgsProcessingException("Source and destination are the same cell")

        feedback.pushInfo(f"Window {win_h}x{win_w}, cell {px_w:.2f}x{px_h:.2f}")
        feedback.pushInfo(f"Source pixel {s} elev {height[s]:.2f}")
        feedback.pushInfo(f"Destination pixel {d} elev {height[d]:.2f}")
        feedback.pushInfo(f"N={n_routes}, penalty={penalty}, "
                          f"alpha={alpha}, beta={beta}, eta={eta}")

        # Output sink
        fields = QgsFields()
        fields.append(QgsField("route_id", QVariant.Int))
        fields.append(QgsField("energy", QVariant.Double))
        fields.append(QgsField("length_m", QVariant.Double))
        fields.append(QgsField("shared_cells", QVariant.Int))

        (sink, sink_id) = self.parameterAsSink(
            parameters, self.OUTPUT, context, fields,
            QgsWkbTypes.LineString, dem_crs
        )
        if sink is None:
            raise QgsProcessingException("Failed to create output sink")

        # --- Iterative penalization loop ---
        H, W = height.shape
        # `used_count[r, c]` = number of prior routes that visited this cell.
        # Penalty multiplier on baseline cost = penalty ** used_count.
        used_count = np.zeros((H, W), dtype=np.int32)

        for k in range(n_routes):
            if feedback.isCanceled():
                break
            feedback.pushInfo(f"--- Computing route {k + 1} of {n_routes} ---")

            path, total_E, total_L = self._astar_path(
                height, mask, s, d,
                alpha=alpha, beta=beta, eta=eta,
                dx=px_w, dy=px_h,
                penalty=penalty, used_count=used_count,
                feedback=feedback,
            )
            if path is None:
                feedback.pushWarning(f"Route {k + 1} unreachable; stopping.")
                break

            # Count how many cells of this path were already used by prior routes
            shared = int(sum(1 for (r, c) in path if used_count[r, c] > 0))

            # Pixel coords -> world coords (cell centres)
            pts = []
            for (r, c) in path:
                x = sub_gt[0] + (c + 0.5) * sub_gt[1]
                y = sub_gt[3] + (r + 0.5) * sub_gt[5]
                pts.append(QgsPointXY(x, y))

            feat = QgsFeature(fields)
            feat.setGeometry(QgsGeometry.fromPolylineXY(pts))
            feat.setAttributes([k + 1, float(total_E), float(total_L), shared])
            sink.addFeature(feat)

            feedback.pushInfo(
                f"Route {k + 1}: energy={total_E:.3g}, "
                f"length={total_L:.1f} m, shared cells={shared}/{len(path)}"
            )

            # Penalize all cells on this route for the next iteration
            for (r, c) in path:
                used_count[r, c] += 1

            feedback.setProgress(int(100 * (k + 1) / n_routes))

        return {self.OUTPUT: sink_id}

    @staticmethod
    def _astar_path(height, mask, start, goal, alpha, beta, eta, dx, dy,
                    penalty, used_count, feedback):
        """A* from `start` to `goal` with per-cell baseline-cost multiplier
        `penalty ** used_count[v]` applied at the destination cell of each
        edge. Returns (path, total_E, total_L) or (None, inf, 0).

        The penalty multiplies only the alpha*dist term, not beta*dh: the
        gravitational climb is unavoidable regardless of which cells you
        traverse, so penalizing it would distort the cost interpretation.
        """
        H, W = height.shape
        diag = float(np.hypot(dx, dy))
        MOVES = [(-1, -1, diag), (-1, 0, dy), (-1, 1, diag),
                 ( 0, -1, dx),                ( 0, 1, dx),
                 ( 1, -1, diag), ( 1, 0, dy), ( 1, 1, diag)]

        h_goal = height[goal]

        def heuristic(r, c):
            # Admissible lower bound: at least the Euclidean distance plus
            # the unavoidable net climb (regardless of route).
            dr = (r - goal[0]) * dy
            dc = (c - goal[1]) * dx
            straight = float(np.hypot(dr, dc))
            climb = max(0.0, h_goal - height[r, c])
            return alpha * straight + beta * climb

        E = np.full((H, W), np.float32(np.inf), dtype=np.float32)
        L = np.full((H, W), np.float32(np.inf), dtype=np.float32)
        parent_r = np.full((H, W), -1, dtype=np.int32)
        parent_c = np.full((H, W), -1, dtype=np.int32)

        E[start] = 0.0
        L[start] = 0.0
        heap = [(heuristic(*start), 0.0, start[0], start[1])]
        settled = np.zeros((H, W), dtype=bool)

        while heap:
            if feedback.isCanceled():
                return None, float("inf"), 0.0
            f, g, r, c = heapq.heappop(heap)
            if settled[r, c]:
                continue
            settled[r, c] = True
            if (r, c) == goal:
                break
            h_here = height[r, c]
            for dr, dc, dist in MOVES:
                nr = r + dr
                nc = c + dc
                if nr < 0 or nr >= H or nc < 0 or nc >= W:
                    continue
                if not mask[nr, nc] or settled[nr, nc]:
                    continue

                dh = height[nr, nc] - h_here
                if dh >= 0.0:
                    edge = alpha * dist + beta * dh
                else:
                    edge = alpha * dist - eta * beta * (-dh)
                    if edge < 0.0:
                        edge = 0.0

                # Apply usage penalty to the baseline (alpha*dist) component
                # only, by adding (penalty ** used - 1) * alpha * dist.
                used = used_count[nr, nc]
                if used > 0:
                    mult = penalty ** used
                    edge += (mult - 1.0) * alpha * dist

                tentative = g + edge
                if tentative < E[nr, nc]:
                    E[nr, nc] = tentative
                    L[nr, nc] = L[r, c] + dist
                    parent_r[nr, nc] = r
                    parent_c[nr, nc] = c
                    heapq.heappush(
                        heap,
                        (tentative + heuristic(nr, nc), tentative, nr, nc)
                    )

        if not settled[goal]:
            return None, float("inf"), 0.0

        # Reconstruct path
        path = [goal]
        r, c = goal
        while parent_r[r, c] >= 0:
            r, c = int(parent_r[r, c]), int(parent_c[r, c])
            path.append((r, c))
        path.reverse()
        return path, float(E[goal]), float(L[goal])
