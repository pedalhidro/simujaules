// Network line overlay, snapToNetwork(), lat/lng ↔ DEM pixel conversion.
import "./water.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { map } from "./map.js";
import { state } from "./state.js";
import { status } from "./dom.js";

// ---- Optional vector-network rendering (black lines, fixed ground width) --
// Leaflet polyline weights are in CSS pixels, so a fixed ground width needs
// a per-zoom conversion: metres per CSS pixel in Web Mercator at zoom z is
// 156543.03 · cos(lat) / 2^z. Re-applied on zoomend and on width/opacity
// input changes (live setStyle on the existing layers — no rebuild).

export function networkLineWidthM() {
  const v = parseFloat(document.getElementById("vec-render-width")?.value);
  return Number.isFinite(v) && v > 0 ? v : 4;
}

export function networkLineOpacity() {
  const v = parseFloat(document.getElementById("vec-render-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

export function networkLineWeightPx() {
  const zoom = map.getZoom();
  const lat = map.getCenter().lat;
  const mPerPx = 156543.03392 * Math.abs(Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  // Floor at 0.75 px so the network stays visible when zoomed far out.
  return Math.max(0.75, networkLineWidthM() / mPerPx);
}

export function applyNetworkLinesOverlay() {
  if (state.networkLinesLayer) { state.networkLinesLayer.remove(); state.networkLinesLayer = null; }
  const on = !!document.getElementById("vec-render")?.checked;
  if (!on) return;
  if (!state.networkLines || !state.networkLines.length) {
    if (state.networkMask) {
      // Mask exists but geometry wasn't kept (over the vertex cap).
      status.textContent = t("status.net_too_large");
    }
    return;
  }
  // One shared canvas renderer — thousands of SVG paths would crawl.
  const renderer = L.canvas({ padding: 0.3, pane: "networkPane" });
  const weight = networkLineWeightPx();
  const opacity = networkLineOpacity();
  // A SINGLE Leaflet MultiPolyline (nested latlngs, one per line) instead of
  // one L.Polyline PER line — a city-scale network is 50k-200k lines, and one
  // layer object per line means seconds of main-thread build time plus
  // Leaflet re-iterating every one of them on every pan/zoom redraw. All
  // lines share the same style, so a single layer renders the identical
  // image.
  state.networkLinesLayer = L.polyline(state.networkLines, {
    color: "#000",
    weight,
    opacity,
    interactive: false,
    renderer,
    pane: "networkPane",
  }).addTo(map);
}

export function updateNetworkLineStyle() {
  if (!state.networkLinesLayer) return;
  const weight = networkLineWeightPx();
  const opacity = networkLineOpacity();
  // state.networkLinesLayer is a single L.Polyline since applyNetworkLinesOverlay
  // was switched to the MultiPolyline form; the eachLayer branch is kept only
  // in case a layerGroup ever occurs again here.
  if (typeof state.networkLinesLayer.setStyle === "function") state.networkLinesLayer.setStyle({ weight, opacity });
  else state.networkLinesLayer.eachLayer((l) => l.setStyle({ weight, opacity }));
}

map.on("zoomend", updateNetworkLineStyle);

// Whether the loaded network actually constrains the NEXT compute. The
// "Constrain compute to network" checkbox lets a network stay loaded —
// e.g. for the vector line rendering — without restricting the search
// graph (or snapping clicks, or gating src/dst).
export function networkConstraintActive() {
  return !!state.networkMask && (document.getElementById("vec-constrain")?.checked ?? true);
}

// Place the PRIMARY density tweaks (#passes-primary) under the sub-group that
// matches the DISPLAYED passes channel, and show/hide 3C.a / 3C.b accordingly:
//   - terrain (unconstrained selection, OR a compute with no network) → 3C.b
//   - network (constrained / difference A-channel)                    → 3C.a
//   - difference with both passes channels (dualPasses) → 3C.b also shows the
//     terrain B-channel overrides (#passes-dual-row).
// `networkUsed` must reflect whether THIS result is network-constrained (NOT just
// the energy-source value, which is "constrained" by default even for a plain
// terrain compute — that was the bug).
export function applyDensityChannelGroups(energySel, networkUsed, dualPasses) {
  const primaryIsTerrain = energySel === "unconstrained" || (energySel !== "difference" && !networkUsed);
  const primaryCtl = document.getElementById("passes-primary");
  const netGroup = document.getElementById("result-density-net-group");
  const netBody  = document.getElementById("density-net-body");
  const terrGroup = document.getElementById("result-density-terrain-group");
  const terrBody  = document.getElementById("density-terrain-body");
  const dualRow   = document.getElementById("passes-dual-row");
  if (primaryCtl) {
    const host = primaryIsTerrain ? terrBody : netBody;
    if (host && primaryCtl.parentElement !== host) host.insertBefore(primaryCtl, host.firstChild);
  }
  if (netGroup)  netGroup.style.display  = primaryIsTerrain ? "none" : "";
  if (terrGroup) terrGroup.style.display = (primaryIsTerrain || dualPasses) ? "" : "none";
  if (dualRow)   dualRow.style.display   = dualPasses ? "" : "none";
}

// Snap a (row, col) pixel to the nearest network cell. Expanding-ring
// search with NO hard cutoff (capped only by the grid): the old version
// gave up at the snap-radius input, which on sparse networks turned every
// map click into a rejection — src never set, Compute permanently
// disabled. The radius input is now the "silent zone": snaps within it
// are quiet, snaps beyond it work too but the caller can tell the user
// how far the point moved (see snapToNetwork.lastDistance).
// Returns the original RC when the network is off / not constraining /
// genuinely empty.
export function snapToNetwork(rc) {
  snapToNetwork.lastDistance = 0;
  if (!networkConstraintActive() || !state.dem) return rc;
  const [r, c] = rc;
  const { W, H, mask } = state.dem;
  if (r < 0 || r >= H || c < 0 || c >= W) return rc;
  if (state.networkMask[r * W + c]) return rc;
  const net = state.networkMask;
  const maxRing = Math.max(H, W);
  for (let ring = 1; ring <= maxRing; ring++) {
    let bestD2 = Infinity, bestRC = null;
    // Walk the square ring at Chebyshev distance `ring`. The first ring
    // containing network cells holds the Euclidean nearest among rings
    // ≤ ring+1; checking one extra ring after a hit keeps it exact enough
    // for snapping purposes (cells, not metres).
    const scanRing = (rg) => {
      for (let dc = -rg; dc <= rg; dc++) {
        for (const dr of (Math.abs(dc) === rg
          ? Array.from({ length: 2 * rg + 1 }, (_, k) => k - rg)
          : [-rg, rg])) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
          const i = rr * W + cc;
          if (net[i] && mask[i]) {
            const d2 = dr * dr + dc * dc;
            if (d2 < bestD2) { bestD2 = d2; bestRC = [rr, cc]; }
          }
        }
      }
    };
    scanRing(ring);
    if (bestRC) {
      scanRing(Math.min(maxRing, ring + 1));
      snapToNetwork.lastDistance = Math.sqrt(bestD2);
      return bestRC;
    }
  }
  return rc; // empty network — caller handles the message
}

// ------- Map clicks: set points -------
// Convert lat/lon to DEM pixel coords. For a UTM DEM this needs proj4; for
// the prototype we accept WGS84 DEMs OR provide a small UTM helper.
// The cleanest demo path is to show the DEM extent on the map in its native
// units. To keep dependencies minimal, the prototype assumes DEMs in EPSG:4326.
// Production: pull in proj4 and parse the GeoKeys to get the source CRS.

export function latLngToPixel(latlng) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, W, H, isGeographic } = state.dem;
  // For a geographic DEM (lon = x, lat = y):
  if (isGeographic) {
    const col = Math.floor((latlng.lng - originX) / dx);
    const row = Math.floor((originY - latlng.lat) / dy);
    if (row < 0 || row >= H || col < 0 || col >= W) return null;
    return [row, col];
  }
  // For UTM DEMs we'd need proj4 here. As a fallback, treat the click
  // as if it were in the DEM's native units (only useful for testing
  // against a small DEM you've manually situated).
  return null;
}

export function pixelToLatLng(r, c) {
  if (!state.dem) return null;
  const { originX, originY, dx, dy, isGeographic } = state.dem;
  if (isGeographic) {
    return L.latLng(originY - (r + 0.5) * dy, originX + (c + 0.5) * dx);
  }
  return null;
}
