// Field rendering: energy / passes / relief / impassable overlays, layer
// controls, legend ticks and range inputs. Style-only — never recomputes.
import "./maxseg.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { clearStyleDirty } from "./boot.js";
import { map } from "./map.js";
import { state } from "./state.js";
import { applyDensityChannelGroups, networkConstraintActive } from "./network-view.js";
import {
  NET_ORANGE_CSS, TERR_BLUE_CSS, bindRouteCompare, graphModeActive, removeGraphLayers,
  renderGraphOverlay,
} from "./graph-mode.js";
import { formatEnergy, formatSci } from "./estimate.js";
import { COLORMAPS, colormap, routeColour } from "./colormaps.js";

// Re-render the cached energy + passes overlays with the currently-selected
// colormap. Called from renderResult (after a compute), from the colormap
// selector, and from any of the per-field range inputs.
export function rerenderCachedResult() {
  // Graph-mode results live on their own vector layer — recolor them and skip
  // the raster pipeline entirely (style knobs still apply, no recompute).
  if (state.lastGraphResult && graphModeActive()) { renderGraphOverlay(); return; }
  // Reverted to grid rendering — drop any leftover graph overlay.
  removeGraphLayers();
  const r = state.lastResult;
  if (!r || !state.dem) return;
  const { path, routes } = r;
  const { H, W, originX, originY, dx, dy, isGeographic } = state.dem;

  // After a compare run, the scenario selector switches BOTH layers.
  // Energy: constrained (default) / unconstrained / difference field.
  // Passes: constrained / unconstrained, and in "difference" mode the two
  // scenarios render TOGETHER — constrained in light red, unconstrained in
  // light green, shared scale (no subtraction; overlap blends to yellow).
  // Pure re-render — no recompute.
  const energySel = document.getElementById("energy-source")?.value || "constrained";
  const energy = (r.energyAlt && energySel !== "constrained" && r.energyAlt[energySel])
    ? r.energyAlt[energySel]
    : r.energy;
  const dualPasses = energySel === "difference" && r.passes && r.passesAlt?.unconstrained;
  // Network-constrained if this result carries a compare (energyAlt ⇒ a network
  // was used) OR the network is currently constraining the grid. (energySel alone
  // is "constrained" by default even for a plain terrain compute — the old bug.)
  const networkUsed = !!r.energyAlt || networkConstraintActive();
  applyDensityChannelGroups(energySel, networkUsed, dualPasses);
  const passes = (r.passesAlt && energySel === "unconstrained" && r.passesAlt.unconstrained)
    ? r.passesAlt.unconstrained
    : r.passes;

  // -- Energy layer. In density mode this is the per-cell mean energy
  // across reference points (Infinity where unreachable from every ref);
  // otherwise it's the regular src/dst Dijkstra output. Default range
  // is percentile-clipped at p1/p80 — the long tail of "very far from
  // src" cells dominated the raw min/max stretch and washed everything
  // else into the bottom of the colormap.
  if (energy) {
    const out = renderFieldToDataURL(energy, W, H, {
      usePercentileBounds: true,
      percentiles: [1, 80],
      userMin: readRangeInput("vmin", null),
      userMax: readRangeInput("vmax", null),
      useGreyscale: false,
      treatZeroAsTransparent: false,
    });
    state.energyDataUrl = out.url;
    state.lastAutoMin = out.lo;
    state.lastAutoMax = out.hi;
  } else {
    state.energyDataUrl = null;
  }

  // -- Passes layer (greyscale, mirrors energy's absolute-range UI) --
  // Greyscale so additive blending on top of the colour-mapped energy
  // brightens "highway" cells without imposing its own hue. When blend
  // mode is "normal" the renderer paints with full alpha so dim cells
  // read as solid black instead of transparent.
  if (passes && dualPasses && document.getElementById("passes-blend")?.value === "sum-data") {
    // Soma de DADOS (A+B): os dois cenários somados célula a célula e
    // pintados numa paleta só, em composição normal — escala honesta,
    // independente do basemap (a "soma de cores"/plus-lighter soma as CORES
    // já pintadas contra tudo que está por baixo). Usa os controles do canal
    // A; os overrides B (3C.b) não se aplicam à soma. Mesmas opções de
    // render do ramo de campo único logo abaixo — os dois têm que ler igual.
    const a = r.passes, b2 = r.passesAlt.unconstrained;
    const sum = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) sum[i] = a[i] + b2[i];
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    const out = renderFieldToDataURL(sum, W, H, {
      usePercentileBounds: true,
      percentiles: [10, 90],
      maxAboveMin: true,
      densityNormalize: true,
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      useGreyscale: true,
      solidAlpha: false,
      treatZeroAsTransparent: true,
    });
    state.passesDataUrl = out.url;
    state.lastPassesAutoMin = out.lo;
    state.lastPassesAutoMax = out.hi;
  } else if (passes && dualPasses) {
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    const gammaB = parseFloat(document.getElementById("passes-gamma-b")?.value);
    const winB = parseInt(document.getElementById("passes-mean-window-b")?.value, 10);
    const out = renderDualPassesToDataURL(r.passes, r.passesAlt.unconstrained, W, H, {
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      userMinB: readRangeInput("passes-vmin-b", null),
      userMaxB: readRangeInput("passes-vmax-b", null),
      gammaB: Number.isFinite(gammaB) ? gammaB : null,
      meanWindowB: Number.isFinite(winB) ? winB : null,
    });
    state.passesDataUrl = out.url;
    state.lastPassesAutoMin = out.lo;
    state.lastPassesAutoMax = out.hi;
  } else if (passes) {
    const blend = document.getElementById("passes-blend")?.value || "plus-lighter";
    const gamma = parseFloat(document.getElementById("passes-gamma")?.value);
    const win = parseInt(document.getElementById("passes-mean-window")?.value, 10);
    // "energy" blend: corridors take the energy field's colour (same
    // resolved lo/hi as the energy layer, rendered just above) and the
    // passes intensity drives the OPACITY — vmin/vmax/gamma shape the
    // alpha ramp. Falls back to greyscale when no energy field exists.
    const energyColor = blend === "energy" && energy && Number.isFinite(state.lastAutoMin);
    const out = renderFieldToDataURL(passes, W, H, {
      // p10/p90 default; passes counts are heavily long-tailed and a few
      // "highway" cells would otherwise dominate the stretch. maxAboveMin re-takes
      // p90 over only the cells above auto-min (the near-zero tail washed it out).
      usePercentileBounds: true,
      percentiles: [10, 90],
      maxAboveMin: true,
      densityNormalize: true, // counts → density units (matches multi-ref density)
      userMin: readRangeInput("passes-vmin", null),
      userMax: readRangeInput("passes-vmax", null),
      gamma: Number.isFinite(gamma) ? gamma : 1,
      meanWindow: Number.isFinite(win) && win > 1 ? win : 1,
      useGreyscale: !energyColor,
      colorField: energyColor
        ? { field: energy, lo: state.lastAutoMin, hi: state.lastAutoMax }
        : null,
      solidAlpha: blend === "normal",
      treatZeroAsTransparent: true,
    });
    state.passesDataUrl = out.url;
    state.lastPassesAutoMin = out.lo;
    state.lastPassesAutoMax = out.hi;
  } else {
    state.passesDataUrl = null;
  }

  // Apply both overlays to the map (creates / updates Leaflet layers).
  applyEnergyOverlay();
  applyPassesOverlay();
  applyLayerControls(); // visibility/opacity/blend

  // Clear existing route polylines before redrawing
  if (state.pathLine) { state.pathLine.remove(); state.pathLine = null; }
  if (state.routeLines) {
    for (const ln of state.routeLines) ln.remove();
  }
  state.routeLines = [];

  function pathToLatLngs(p) {
    return p.map((idx) => {
      const rr = (idx / W) | 0;
      const cc = idx - rr * W;
      return [originY - (rr + 0.5) * dy, originX + (cc + 0.5) * dx];
    });
  }

  if (r.pathAlt && r.pathAlt.length > 0 && isGeographic) {
    // Compare run: the scenario picker switches the BEST ROUTE the same way it
    // switches the field. Network (constrained) route in orange, unconstrained
    // TERRAIN route in blue, both together in the difference view — matching the
    // density difference colours. Single best per scenario (top-N collapses to
    // the optimum route here).
    const netPath = (path && path.length) ? path
      : (routes && routes.length ? routes[0].path : null);
    const netE = r.pathEnergy ?? (routes && routes.length ? routes[0].energy : null);
    const netL = r.pathLengthM ?? (routes && routes.length ? routes[0].length : null);
    const terrE = r.pathAltEnergy, terrL = r.pathAltLengthM;
    const showNet  = energySel === "constrained" || energySel === "difference";
    const showTerr = energySel === "unconstrained" || energySel === "difference";
    if (showTerr) {
      const ln = L.polyline(pathToLatLngs(r.pathAlt), {
        color: TERR_BLUE_CSS, weight: 4, opacity: 0.95, pane: "routesPane",
      }).addTo(map);
      bindRouteCompare(ln, "terrain", netE, netL, terrE, terrL);
      state.routeLines.push(ln);
    }
    if (showNet && netPath) {
      const ln = L.polyline(pathToLatLngs(netPath), {
        color: NET_ORANGE_CSS, weight: 4, opacity: 0.95, pane: "routesPane",
      }).addTo(map);
      bindRouteCompare(ln, "network", netE, netL, terrE, terrL);
      state.routeLines.push(ln);
    }
  } else if (routes && routes.length > 0 && isGeographic) {
    // Top-N: colour each route by rank using the routes-colormap, with a
    // weight that decays slightly so the optimal route reads strongest.
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const colour = routeColour(i, routes.length);
      const weight = Math.max(2.5, 5 - i * 0.4);
      const opacity = Math.max(0.55, 0.95 - i * 0.05);
      const ln = L.polyline(pathToLatLngs(r.path), {
        color: colour, weight, opacity, pane: "routesPane",
      }).bindTooltip(t("stats.route_tooltip", i + 1, r.energy.toExponential(2), (r.length / 1000).toFixed(2))).addTo(map);
      state.routeLines.push(ln);
    }
  } else if (path && path.length > 0 && isGeographic) {
    state.pathLine = L.polyline(pathToLatLngs(path), {
      color: "#4cc9f0", weight: 4, opacity: 0.95, pane: "routesPane",
    }).addTo(map);
  }

  // Update the legend's numeric ticks to reflect the current mapping.
  updateLegendTicks();
  // Update placeholders so the user can see what "auto" is currently using.
  syncRangePlaceholders();
  // Whatever style was rendered is now the "clean" snapshot. Any input
  // change after this point will re-mark dirty.
  clearStyleDirty();
}

// Separable 2D box blur. Treats the input as zero-padded outside the grid;
// unsettled cells (value 0 in the passes field) get averaged in, which lets
// the smoothed field bleed slightly past the original settled extent — the
// natural "blur" look the user wants.
function boxBlur2D(field, W, H, win) {
  const N = W * H;
  if (win <= 1) return field;
  const half = (win - 1) >> 1;
  // tmp/out are render-only temporaries (Float32, not Float64): the canvas
  // quantises to 8-bit anyway, so a single f32 rounding per cell is
  // invisible, and it halves this function's transient memory on huge DEMs.
  // The sliding-window accumulators (sum/count) stay scalar f64 — only the
  // per-cell STORE rounds. Never touch state.lastResult.passes itself.
  const tmp = new Float32Array(N);
  // Horizontal pass: sliding-window mean over each row.
  for (let r = 0; r < H; r++) {
    const rowOff = r * W;
    let sum = 0, count = 0;
    for (let c = 0; c <= half && c < W; c++) {
      sum += field[rowOff + c];
      count++;
    }
    tmp[rowOff] = sum / count;
    for (let c = 1; c < W; c++) {
      const addC = c + half;
      const remC = c - half - 1;
      if (addC < W) { sum += field[rowOff + addC]; count++; }
      if (remC >= 0) { sum -= field[rowOff + remC]; count--; }
      tmp[rowOff + c] = sum / count;
    }
  }
  // Vertical pass over tmp.
  const out = new Float32Array(N);
  for (let c = 0; c < W; c++) {
    let sum = 0, count = 0;
    for (let r = 0; r <= half && r < H; r++) {
      sum += tmp[r * W + c];
      count++;
    }
    out[c] = sum / count;
    for (let r = 1; r < H; r++) {
      const addR = r + half;
      const remR = r - half - 1;
      if (addR < H) { sum += tmp[addR * W + c]; count++; }
      if (remR >= 0) { sum -= tmp[remR * W + c]; count--; }
      out[r * W + c] = sum / count;
    }
  }
  return out;
}

// Render a 2D scalar field to a base64 dataURL.
// Range: vmin/vmax in real units. When both blank → auto, from the percentile
// clip (`opts.percentiles`, default [10, 90]; all callers set
// usePercentileBounds:true). Mapping is linear lo→hi.
// Returns { url, lo, hi } so the caller can record the resolved bounds
// for the legend / placeholder display.
// `useGreyscale: true` paints a black→white ramp instead of the active
// colormap — used for the passes layer.
// `meanWindow > 1` applies a separable box-blur prefilter (treats unsettled
// cells as zero, so the smoothed field bleeds slightly outside the original
// settled extent — that's the desired blur look).
// `gamma`: exponent γ such that `t' = t^γ`. γ=1 → identity. γ=2 squares
// the intensity (darkens dim cells). γ=0.5 takes the square root
// (brightens dim cells).
// Passes are subtree-size COUNTS; show them in the SAME density units the
// multi-reference density already uses (÷H·W twice) so passes ALWAYS read as a
// normalized density, never raw counts. A field whose max is already < 1 is an
// existing density and is left untouched (no double-division). The scale is a
// constant, so the percentile-normalized COLOUR is unchanged — only the displayed
// numbers (auto bounds + placeholders) move to density units.
export function passesAsDensity(field, W, H) {
  if (!field || !field.length) return field;
  let max = 0;
  for (let i = 0; i < field.length; i++) { if (field[i] > max) max = field[i]; }
  if (max < 1) return field; // already a density (or empty) — counts are integers ≥ 1
  const k = 1 / (W * H * W * H);
  // Render-only temporary: Float32 halves transient memory on huge DEMs
  // (density values ~1e-17·counts are far above the f32 denormal floor, and
  // the canvas quantises to 8-bit anyway). Never touch the cached
  // state.lastResult.passes/passesAlt arrays themselves.
  const out = new Float32Array(field.length);
  for (let i = 0; i < field.length; i++) out[i] = field[i] * k;
  return out;
}

// Deterministic RNG for the percentile reservoir samplers below. The auto
// bounds ("auto = p90" etc.) must be IDENTICAL across re-renders of the same
// field — with Math.random every render drew a different 100k-cell sample, so
// the first render, a style refresh, and a range reset each showed slightly
// different "auto" numbers. Fixed-seed mulberry32: same field + options →
// bit-identical bounds; statistically equivalent to Math.random for sampling.
function reservoirRng() {
  let a = 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderFieldToDataURL(field, W, H, opts) {
  const N = W * H;
  if (opts.densityNormalize) field = passesAsDensity(field, W, H);

  // Optional mean filter. boxBlur returns a fresh Float64Array.
  const work = opts.meanWindow && opts.meanWindow > 1
    ? boxBlur2D(field, W, H, opts.meanWindow)
    : field;

  // Resolve bounds.
  let autoLo = Infinity, autoHi = 0;
  if (opts.usePercentileBounds) {
    const [pLo, pHi] = opts.percentiles || [10, 90];
    // Reservoir-sample valid cells into a fixed-size Float32Array.
    // Pushing every valid value into a regular Array OOMs the tab on
    // 100M+-cell DEMs (multi-GB heap) — the typed-array reservoir
    // gives sub-1% percentile accuracy at 100k samples regardless
    // of N. Same pattern as renderReliefToDataURL.
    const SAMPLE_CAP = 100_000;
    const samples = new Float32Array(SAMPLE_CAP);
    const rand = reservoirRng(); // deterministic: auto bounds stable across re-renders
    let collected = 0;
    let seen = 0;
    for (let i = 0; i < N; i++) {
      const v = work[i];
      if (!Number.isFinite(v) || (opts.treatZeroAsTransparent && v <= 0)) continue;
      if (collected < SAMPLE_CAP) {
        samples[collected++] = v;
      } else {
        const j = Math.floor(rand() * (seen + 1));
        if (j < SAMPLE_CAP) samples[j] = v;
      }
      seen++;
    }
    if (collected > 0) {
      // Float32Array.sort sorts numerically by default; a comparator would
      // box every value to a Number wrapper.
      const sorted = samples.subarray(0, collected).slice().sort();
      // Clamp: p=100 would otherwise index sorted[length] (undefined).
      const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
      autoLo = at(pLo);
      autoHi = at(pHi);
      // Passes density heuristic: the long low tail (near-zero cells) drags the
      // pHi percentile down, washing the field out. Re-take pHi over only the
      // cells STRICTLY above auto-min so the upper bound tracks the actual ridges.
      if (opts.maxAboveMin) {
        let s = 0;
        while (s < sorted.length && sorted[s] <= autoLo) s++;
        const len = sorted.length - s;
        if (len > 0) autoHi = sorted[s + Math.min(len - 1, Math.floor(len * pHi / 100))];
      }
    }
  }
  if (opts.autoMin != null) autoLo = opts.autoMin;
  if (opts.autoMax != null) autoHi = opts.autoMax;

  // Every caller passes usePercentileBounds:true, so bounds come from the
  // percentile clip above and the value→colour mapping is always linear
  // (lo→hi). The old raw-min/max auto path + sqrt-stretch branch had no caller
  // and was removed; pin either bound (userMin/userMax) for manual clamping.
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);

  // Stride-downsample the canvas on huge DEMs so createImageData can't OOM
  // the tab (stride=1 → byte-identical to full-res for DEMs under the cap).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);

  // Optional second field driving the COLOUR while the primary field
  // drives the ALPHA ("energy color" passes blend): hue from
  // colormap((colorField - lo) / span) with the caller-supplied bounds
  // (the energy layer's resolved lo/hi, so corridors match its legend),
  // opacity from the primary t (so passes vmin/vmax/gamma shape the
  // alpha ramp). Cells where the colour field is Infinity but the
  // primary is drawn (e.g. over-budget corridor cells in round/total
  // mode) clamp to the top colour — they're beyond the displayed max.
  const cfField = opts.colorField ? opts.colorField.field : null;
  let cfLo = 0, cfSpan = 1;
  if (opts.colorField) {
    cfLo = opts.colorField.lo;
    cfSpan = opts.colorField.hi - opts.colorField.lo;
    if (!Number.isFinite(cfLo)) cfLo = 0;
    if (!Number.isFinite(cfSpan) || cfSpan <= 0) cfSpan = 1;
  }

  // Iterate output pixels; sample the source field at the chosen stride.
  // `i` indexes the full-res field (and colorField), `o` the output canvas.
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const i = srcR * W + oc * stride;
      const o = or * outW + oc;
      const v = work[i];
      // v <= 0 matches the percentile sampler's exclusion above (the two
      // predicates used to disagree: sampler v<=0, paint v===0, so negatives
      // were dropped from the bounds yet still painted).
      const unsettled =
        !Number.isFinite(v) || (opts.treatZeroAsTransparent && v <= 0);
      if (unsettled) {
        img.data[4 * o + 3] = 0;
        continue;
      }
      let t = (v - lo) / span;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      // Gamma adjustment: t' = t^γ. γ=1 leaves the mapping unchanged.
      if (gammaExp !== 1) t = Math.pow(t, gammaExp);
      let r2, g2, b2, a2;
      if (cfField) {
        const cv = cfField[i];
        let tc = Number.isFinite(cv) ? (cv - cfLo) / cfSpan : 1;
        if (tc < 0) tc = 0;
        else if (tc > 1) tc = 1;
        [r2, g2, b2] = colormap(tc);
        a2 = Math.round(t * 255);
      } else if (opts.tint && opts.tintOpacityRamp) {
        // Graph-mode difference view only: match buildGraphFieldLayer's vector
        // channel exactly — constant hue, opacity 0.3+0.7*t (NOT rgb*t) — so
        // the raster terrain channel and the orange network vectors read at
        // the same visual intensity for equal traffic. The plain rgb*t ramp
        // below is what raster-mode's difference view (renderDualPassesToDataURL)
        // still relies on and must stay untouched.
        const [tr, tg, tb] = opts.tint;
        r2 = tr; g2 = tg; b2 = tb;
        a2 = Math.round((0.3 + 0.7 * t) * 255);
      } else if (opts.tint) {
        // Solid colour scaled by intensity (the orange/azure difference channels);
        // alpha = intensity so dark cells are transparent and additive blends sum.
        const [tr, tg, tb] = opts.tint;
        r2 = Math.round(tr * t); g2 = Math.round(tg * t); b2 = Math.round(tb * t);
        a2 = Math.round(t * 255);
      } else if (opts.useGreyscale) {
        const g = Math.round(t * 255);
        r2 = g2 = b2 = g;
        // For additive-style blends (plus-lighter, screen, multiply, etc.)
        // alpha=brightness makes black cells contribute nothing while bright
        // cells fully add. For "normal" blend that trick reads wrong (dark
        // cells become transparent and the energy field bleeds through), so
        // we use full alpha and let the slider do the dimming. The flag is
        // set by the renderer based on the active blend mode.
        a2 = opts.solidAlpha ? 255 : g;
      } else {
        [r2, g2, b2] = colormap(t);
        // Fully opaque on the canvas; user-facing dimming comes from the
        // L.imageOverlay opacity slider so that 100% on the slider really
        // means 100% opaque.
        a2 = 255;
      }
      img.data[4 * o + 0] = r2;
      img.data[4 * o + 1] = g2;
      img.data[4 * o + 2] = b2;
      img.data[4 * o + 3] = a2;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), lo, hi };
}

// Two-scenario passes render for the "difference" view: constrained passes in
// ORANGE, unconstrained in AZURE BLUE, ADDITIVELY blended on a SHARED scale.
// The bases are additive complements (sum = white), so overlap goes to MAX
// brightness where both scenarios route together, and the alpha adds too so
// coincident corridors pop. The blue–orange axis stays discriminable under
// red–green colour-blindness (unlike the old red/green). No subtraction — the
// user reads where each scenario routes its traffic.
// Per-channel controls: the A (orange/constrained = network) channel uses the
// regular passes inputs; the B (blue/unconstrained = terrain) channel takes
// optional overrides that fall back to A's RESOLVED values when blank — so by
// default both channels share one scale (comparable), and each knob can diverge
// independently. Auto bounds are p10/p90 over BOTH fields' positive cells.
export function renderDualPassesToDataURL(constrained, unconstrained, W, H, opts) {
  const N = W * H;
  // Both channels → density units (counts ×1/(H·W)²; existing densities untouched).
  constrained = passesAsDensity(constrained, W, H);
  unconstrained = passesAsDensity(unconstrained, W, H);
  const winA = opts.meanWindow && opts.meanWindow > 1 ? opts.meanWindow : 1;
  const winB = opts.meanWindowB && opts.meanWindowB > 1
    ? opts.meanWindowB
    : (opts.meanWindowB == null ? winA : 1);
  const a = winA > 1 ? boxBlur2D(constrained, W, H, winA) : constrained;
  const b = winB > 1 ? boxBlur2D(unconstrained, W, H, winB) : unconstrained;

  // Shared auto bounds: reservoir-sample positive cells from both fields.
  const SAMPLE_CAP = 100_000;
  const samples = new Float32Array(SAMPLE_CAP);
  const rand = reservoirRng(); // deterministic: auto bounds stable across re-renders
  let collected = 0, seen = 0;
  for (const f of [a, b]) {
    for (let i = 0; i < N; i++) {
      const v = f[i];
      if (!Number.isFinite(v) || v <= 0) continue;
      if (collected < SAMPLE_CAP) samples[collected++] = v;
      else {
        const j = Math.floor(rand() * (seen + 1));
        if (j < SAMPLE_CAP) samples[j] = v;
      }
      seen++;
    }
  }
  let autoLo = 0, autoHi = 1;
  if (collected > 0) {
    const sorted = samples.subarray(0, collected).slice().sort();
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
    autoLo = at(10);
    autoHi = at(90);
  }
  let lo = opts.userMin != null ? opts.userMin : autoLo;
  let hi = opts.userMax != null ? opts.userMax : autoHi;
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi) || hi <= lo) hi = lo + 1;
  const span = hi - lo;
  const gammaExp = Math.max(0.01, opts.gamma ?? 1);
  // Green channel: explicit overrides, else inherit red's resolved values.
  let loB = opts.userMinB != null ? opts.userMinB : lo;
  let hiB = opts.userMaxB != null ? opts.userMaxB : hi;
  if (!Number.isFinite(loB)) loB = lo;
  if (!Number.isFinite(hiB) || hiB <= loB) hiB = loB + 1;
  const spanB = hiB - loB;
  const gammaExpB = Math.max(0.01, opts.gammaB ?? gammaExp);

  // Channel bases on the COLOURBLIND-SAFE blue–yellow opponent axis (survives
  // red–green CVD, unlike the old red/green), picked as ADDITIVE COMPLEMENTS so
  // their per-channel sum is exactly white (255,255,255) = maximum brightness
  // where both scenarios route together; each alone is maximally discriminable.
  const RA = 255, GA = 165, BA = 60;   // warm orange — A = constrained (network)
  const RB = 0,   GB = 90,  BB = 195;  // azure blue  — B = unconstrained (terrain)

  // Stride-downsample on huge DEMs (stride=1 → byte-identical under the cap).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const i = srcR * W + oc * stride;
      const o = or * outW + oc;
      let tA = (a[i] - lo) / span;
      let tB = (b[i] - loB) / spanB;
      // Full clamp on BOTH ends: a value below the channel's min must floor
      // at 0, not go negative — a negative channel would subtract from the
      // additive sum and could erase the other channel entirely.
      if (!Number.isFinite(tA) || a[i] <= 0 || tA < 0) tA = 0;
      else if (tA > 1) tA = 1;
      if (!Number.isFinite(tB) || b[i] <= 0 || tB < 0) tB = 0;
      else if (tB > 1) tB = 1;
      if (tA <= 0 && tB <= 0) { img.data[4 * o + 3] = 0; continue; }
      if (gammaExp !== 1 && tA > 0) tA = Math.pow(tA, gammaExp);
      if (gammaExpB !== 1 && tB > 0) tB = Math.pow(tB, gammaExpB);
      img.data[4 * o + 0] = Math.min(255, Math.round(RA * tA + RB * tB));
      img.data[4 * o + 1] = Math.min(255, Math.round(GA * tA + GB * tB));
      img.data[4 * o + 2] = Math.min(255, Math.round(BA * tA + BB * tB));
      img.data[4 * o + 3] = Math.min(255, Math.round((tA + tB) * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  return { url: canvas.toDataURL(), lo, hi, loB, hiB };
}

// ============================================================================
// DEM relief layer (elevation + slope hillshade)
// ============================================================================
// Visualises the loaded DEM as cmocean.phase-coloured elevation with a
// white-to-black slope multiplied on top. Both layers share one rendered
// PNG (single Leaflet imageOverlay, single visibility/opacity control) so
// flat terrain reads as the pure elevation colour and steep terrain
// darkens — the classic hillshade aesthetic where cliffs and ridges read
// as shadow.
//
// Spec (fixed, no UI knobs for now):
//   elevation range  : p5 → p80 percentile of valid heights
//   slope range      : 0   → p80 percentile of |∇h| (m/m)
//   slope gamma      : 1.2 (out = pow(slope_norm, 1/1.2))
//   slope colour ramp: white → black   (slope=0 → 1.0, slope=p80 → 0.0)
//   composite        : multiply         out_rgb = elev_rgb · slopeFactor
//   colormap         : cmo_phase (cyclic, perceptually uniform)

// Central-difference slope magnitude in m/m. Edge cells use replicated
// boundary; masked neighbours fall back to the cell's own height (so a
// nodata strip at the DEM edge produces zero slope rather than a wild
// fictitious gradient).
export function computeSlope(height, mask, H, W, dxM, dyM) {
  const slope = new Float32Array(H * W);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      const cw = c > 0     ? c - 1 : c;
      const ce = c < W - 1 ? c + 1 : c;
      const rn = r > 0     ? r - 1 : r;
      const rs = r < H - 1 ? r + 1 : r;
      const wIdx = r  * W + cw;
      const eIdx = r  * W + ce;
      const nIdx = rn * W + c;
      const sIdx = rs * W + c;
      const h0 = height[i];
      const hw = mask[wIdx] ? height[wIdx] : h0;
      const he = mask[eIdx] ? height[eIdx] : h0;
      const hn = mask[nIdx] ? height[nIdx] : h0;
      const hs = mask[sIdx] ? height[sIdx] : h0;
      const spanX = (ce - cw) * dxM;
      const spanY = (rs - rn) * dyM;
      const dhdx = spanX > 0 ? (he - hw) / spanX : 0;
      const dhdy = spanY > 0 ? (hs - hn) / spanY : 0;
      slope[i] = Math.sqrt(dhdx * dhdx + dhdy * dhdy);
    }
  }
  return slope;
}

// Sample size for percentile estimation. 100k samples gives a sub-1 %
// error on p5/p80 of a smooth distribution — well below the visual
// resolution of the colormap. Using regular JS arrays here would balloon
// to multi-gig heaps on a 135 M-cell DEM (the "Sampa Sítio Urbano" case)
// and OOM the tab; typed arrays at fixed size keep this <1 MB regardless.
const RELIEF_PERCENTILE_SAMPLES = 100_000;

// Cap on the canvas backing buffer. Above ~10 M pixels Chrome refuses
// to allocate ImageData, and even when it succeeds the toDataURL cost
// dominates. We downsample by an integer stride and let Leaflet's
// imageOverlay scale the result up to the DEM extent — Leaflet uses
// CSS image-rendering, so the texture maps cleanly across the bounds.
const RELIEF_MAX_CANVAS_PX = 10 * 1024 * 1024;

// Shared canvas cap for the field overlays (energy / passes / impassable),
// mirroring the relief renderer. Above RELIEF_MAX_CANVAS_PX cells we render the
// canvas at an integer-strided lower resolution and let Leaflet's imageOverlay
// scale the texture across the same DEM bounds. Without this, createImageData
// at the full W*H OOMs the tab on huge DEMs (the documented 135 M-cell case
// allocates ~540 MB before toDataURL even runs). Returns stride=1 (byte-
// identical to the old full-res path) for any DEM under the cap.
export function overlayCanvasDims(W, H) {
  const N = W * H;
  let stride = 1;
  if (N > RELIEF_MAX_CANVAS_PX) stride = Math.ceil(Math.sqrt(N / RELIEF_MAX_CANVAS_PX));
  return { stride, outW: Math.max(1, Math.floor(W / stride)), outH: Math.max(1, Math.floor(H / stride)) };
}

export function renderReliefToDataURL(dem, slope) {
  const { H, W, height, mask } = dem;
  const N = H * W;

  // ---- Reservoir-sample valid (height, slope) pairs for percentiles --
  const eSamples = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  const sSamples = new Float32Array(RELIEF_PERCENTILE_SAMPLES);
  const rand = reservoirRng(); // deterministic: auto bounds stable across re-renders
  let collected = 0;
  let seen = 0; // count of valid cells visited
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (collected < RELIEF_PERCENTILE_SAMPLES) {
      eSamples[collected] = height[i];
      sSamples[collected] = slope[i];
      collected++;
    } else {
      // Standard reservoir step: replace position j (uniform in [0, seen])
      // with probability k/seen; here that simplifies to "pick a slot".
      const j = Math.floor(rand() * (seen + 1));
      if (j < RELIEF_PERCENTILE_SAMPLES) {
        eSamples[j] = height[i];
        sSamples[j] = slope[i];
      }
    }
    seen++;
  }
  if (collected === 0) return null;

  // Float32Array.sort sorts numerically by default — no comparator needed
  // (and passing one would coerce values to objects, defeating the point).
  const eSorted = eSamples.subarray(0, collected).slice().sort();
  const sSorted = sSamples.subarray(0, collected).slice().sort();
  const elevMin  = percentileFromSorted(eSorted, 5);
  const elevMax  = percentileFromSorted(eSorted, 80);
  const slopeMax = Math.max(1e-9, percentileFromSorted(sSorted, 80));
  const elevSpan = elevMax - elevMin;

  // ---- Decide canvas size — downsample if the DEM is too big -------
  let stride = 1;
  if (N > RELIEF_MAX_CANVAS_PX) {
    stride = Math.ceil(Math.sqrt(N / RELIEF_MAX_CANVAS_PX));
  }
  const outW = Math.max(1, Math.floor(W / stride));
  const outH = Math.max(1, Math.floor(H / stride));

  // cmo_phase is cyclic — values that wrap past 1.0 alias to the same
  // hue as 0.0, which is fine since we clip to [0, 1].
  const phaseMap = COLORMAPS.cmo_phase;
  const phaseN = phaseMap.length - 1;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(outW, outH);
  const data = imageData.data;

  const invGamma = 1 / 1.2;

  // ---- Render at the (possibly downsampled) output resolution ------
  for (let or = 0; or < outH; or++) {
    const srcR = or * stride;
    for (let oc = 0; oc < outW; oc++) {
      const srcC = oc * stride;
      const srcI = srcR * W + srcC;
      const j = (or * outW + oc) * 4;
      if (!mask[srcI]) {
        data[j + 3] = 0; // transparent over nodata
        continue;
      }

      // -- Elevation lookup
      let er, eg, eb;
      if (elevSpan > 0) {
        const t = Math.max(0, Math.min(1, (height[srcI] - elevMin) / elevSpan));
        const f = t * phaseN;
        const k = Math.floor(f);
        const frac = f - k;
        const a = phaseMap[Math.min(k, phaseN)];
        const b = phaseMap[Math.min(k + 1, phaseN)];
        er = a[0] + (b[0] - a[0]) * frac;
        eg = a[1] + (b[1] - a[1]) * frac;
        eb = a[2] + (b[2] - a[2]) * frac;
      } else {
        // Pathological DEM (all same elevation) — paint mid-colormap.
        const a = phaseMap[Math.floor(phaseN / 2)];
        er = a[0]; eg = a[1]; eb = a[2];
      }

      // -- Slope as gamma-corrected white→black multiplier.
      //    slope=0   → factor 1.0 (multiplying by white leaves elev alone)
      //    slope=p80 → factor 0.0 (multiplying by black collapses to black)
      const sNorm = Math.min(1, slope[srcI] / slopeMax);
      const sGamma = Math.pow(sNorm, invGamma);
      const slopeFactor = 1 - sGamma;
      data[j]     = Math.round(er * slopeFactor);
      data[j + 1] = Math.round(eg * slopeFactor);
      data[j + 2] = Math.round(eb * slopeFactor);
      data[j + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

export function applyDemReliefOverlay() {
  if (state.demReliefOverlay) {
    state.demReliefOverlay.remove();
    state.demReliefOverlay = null;
  }
  if (!state.dem || !state.dem.isGeographic || !state.demReliefDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  // Bounds must match the SAMPLED extent (outW×outH cells at `stride`), not
  // the full DEM: at stride>1 the rendered canvas only covers up to
  // stride-1 fewer rows/cols, so stretching it across the full DEM rectangle
  // shears corridors near the eastern/southern edge. Identical to today
  // when stride=1 or W,H divide evenly.
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const bounds = [[originY - outH * stride * dy, originX], [originY, originX + outW * stride * dx]];
  state.demReliefOverlay = L.imageOverlay(
    state.demReliefDataUrl,
    bounds,
    { opacity: 0.85, pane: "reliefPane" },
  ).addTo(map);
}

export function impassableOverlayOpacity() {
  const v = parseFloat(document.getElementById("imp-opacity")?.value);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

// Paint the EFFECTIVE impassable state to a dataURL for verification: blocked
// water red, reopened bridge corridors green. Returns null when nothing to show.
function renderImpassableDataURL() {
  if (!state.dem || !state.impassable) return null;
  const { H, W } = state.dem;
  const imp = state.impassable;
  // Stride-downsample on huge DEMs (stride=1 → identical under the cap). These
  // are SPARSE features, so we SCATTER each blocked/corridor cell into its
  // downsampled output pixel (point-sampling the strided grid would skip most
  // of them and the overlay would look empty).
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(outW, outH);
  const d = img.data;
  // Clamp both axes: when W/H isn't a multiple of stride, the last
  // W%stride columns (or H%stride rows) would otherwise compute an out-of-
  // range output column/row — WRAPPING to the next row's pixel 0 for the
  // column case (a right-edge blocked cell painting on the left edge one
  // row down) rather than just landing on the last valid pixel.
  const outIdx = (i) => {
    const r = (i / W) | 0, c = i - r * W;
    const or = Math.min(outH - 1, (r / stride) | 0);
    const oc = Math.min(outW - 1, (c / stride) | 0);
    return (or * outW + oc) << 2;
  };
  for (let i = 0; i < imp.length; i++) {
    if (imp[i]) { const o = outIdx(i); d[o] = 220; d[o + 1] = 48; d[o + 2] = 48; d[o + 3] = 255; } // blocked
  }
  const cells = state.corridorCells;
  if (cells) for (let k = 0; k < cells.length; k++) {
    const o = outIdx(cells[k]); d[o] = 40; d[o + 1] = 200; d[o + 2] = 90; d[o + 3] = 255; // corridor
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png");
}

// Build the impassable-layer Leaflet imageOverlay from the current mask +
// corridors. Driven by the #imp-show / #imp-opacity controls in group 1c.
export function applyImpassableOverlay() {
  if (state.impassableOverlay) { state.impassableOverlay.remove(); state.impassableOverlay = null; }
  const show = !!document.getElementById("imp-show")?.checked;
  if (!show || !state.dem || !state.dem.isGeographic || !state.impassable) return;
  const url = renderImpassableDataURL();
  if (!url) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  // Bounds must match the SAMPLED extent (see applyDemReliefOverlay) —
  // identical to today when stride=1 or W,H divide evenly.
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const bounds = [[originY - outH * stride * dy, originX], [originY, originX + outW * stride * dx]];
  state.impassableOverlay = L.imageOverlay(url, bounds, {
    opacity: impassableOverlayOpacity(), pane: "impassablePane",
  }).addTo(map);
}

// Linearly interpolate the p-th percentile (0..100) from a sorted ascending
// array. Returns NaN if the array is empty.
function percentileFromSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const t = Math.max(0, Math.min(100, p)) / 100;
  const f = t * (n - 1);
  const i0 = Math.floor(f);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = f - i0;
  return sorted[i0] + (sorted[i1] - sorted[i0]) * frac;
}

// Build the energy-layer Leaflet imageOverlay from the cached dataURL.
export function applyEnergyOverlay() {
  if (state.energyOverlay) { state.energyOverlay.remove(); state.energyOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.energyDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  // Bounds must match the SAMPLED extent (see applyDemReliefOverlay) —
  // identical to today when stride=1 or W,H divide evenly.
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const bounds = [[originY - outH * stride * dy, originX], [originY, originX + outW * stride * dx]];
  state.energyOverlay = L.imageOverlay(state.energyDataUrl, bounds, { opacity: 0.85, pane: "energyPane" }).addTo(map);
}

// Build the passes-layer Leaflet imageOverlay. Its pane (z 404) sits above
// energy (402) AND the drawn vector network (403), so corridors paint over
// the black network lines.
export function applyPassesOverlay() {
  if (state.passesOverlay) { state.passesOverlay.remove(); state.passesOverlay = null; }
  if (!state.dem || !state.dem.isGeographic || !state.passesDataUrl) return;
  const { H, W, originX, originY, dx, dy } = state.dem;
  // Bounds must match the SAMPLED extent (see applyDemReliefOverlay) —
  // identical to today when stride=1 or W,H divide evenly.
  const { stride, outW, outH } = overlayCanvasDims(W, H);
  const bounds = [[originY - outH * stride * dy, originX], [originY, originX + outW * stride * dx]];
  state.passesOverlay = L.imageOverlay(state.passesDataUrl, bounds, { opacity: 0.7, pane: "passesPane" }).addTo(map);
}

// Apply the live UI controls (visibility, opacity, blend mode) to whichever
// overlays exist. Cheap — no canvas re-render. Also drives the tilemap
// add/remove cycle (we only fetch tiles when the user makes it visible).
export function applyLayerControls() {
  // rmsampa-v2 tile overlay
  const tileVis = document.getElementById("tile-visible")?.checked ?? false;
  const tileOpRaw = parseFloat(document.getElementById("tile-opacity")?.value);
  const tileOp = Number.isFinite(tileOpRaw) ? tileOpRaw : 0.85;
  if (tileVis && !state.tileOverlayActive) {
    state.tileOverlay.addTo(map);
    state.tileOverlayActive = true;
  } else if (!tileVis && state.tileOverlayActive) {
    state.tileOverlay.remove();
    state.tileOverlayActive = false;
  }
  if (state.tileOverlayActive) {
    state.tileOverlay.setOpacity(tileOp);
  }

  if (state.demReliefOverlay) {
    const visible = document.getElementById("relief-visible")?.checked ?? false;
    const opacity = parseFloat(document.getElementById("relief-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.85;
    state.demReliefOverlay.setOpacity(visible ? op : 0);
  }
  if (state.energyOverlay) {
    const visible = document.getElementById("energy-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("energy-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.85;
    state.energyOverlay.setOpacity(visible ? op : 0);
  }
  if (state.passesOverlay) {
    const visible = document.getElementById("passes-visible")?.checked ?? true;
    const opacity = parseFloat(document.getElementById("passes-opacity")?.value);
    const op = Number.isFinite(opacity) ? opacity : 0.7;
    // Graph-mode difference view: state.graphPassesLayer (network vectors) and
    // state.passesOverlay (terrain raster) share passesPane. The graphPassesLayer
    // block below already drives the PANE opacity from this same slider, so
    // ALSO setting the imageOverlay element's own opacity here would apply the
    // slider twice (op × op), making the raster channel read dimmer than the
    // vector channel at the same value. Pin the element to fully opaque and
    // let the pane be the single control in that case.
    state.passesOverlay.setOpacity(state.graphPassesLayer ? 1 : (visible ? op : 0));
    const blend = document.getElementById("passes-blend")?.value || "normal";
    const el = state.passesOverlay.getElement();
    // "energy" e "sum-data" são modos de RENDER (cor/soma assadas no canvas),
    // não blends de CSS — compõem normal.
    if (el) el.style.mixBlendMode = (blend === "energy" || blend === "sum-data") ? "normal" : blend;
  }
  // Reference-point markers: show/hide the whole set as a layer toggle.
  if (state.refMarkers) {
    const visible = document.getElementById("refs-visible")?.checked ?? true;
    for (const m of state.refMarkers) {
      if (visible && !map.hasLayer(m)) m.addTo(map);
      else if (!visible && map.hasLayer(m)) m.remove();
    }
  }
  // Graph-mode passes is a vector layer on passesPane (energy is the raster
  // overlay above) — drive its pane opacity + blend from the Passes controls.
  if (state.graphPassesLayer) {
    const visible = document.getElementById("passes-visible")?.checked ?? true;
    const opRaw = parseFloat(document.getElementById("passes-opacity")?.value);
    const op = Number.isFinite(opRaw) ? opRaw : 0.7;
    const blend = document.getElementById("passes-blend")?.value || "normal";
    const pp = map.getPane("passesPane");
    if (pp) {
      pp.style.opacity = String(visible ? op : 0);
      // Additive ("plus-lighter" / soma de cores) blend makes the near-black
      // low-pass lines contribute nothing, leaving only the bright corridors.
      // "sum-data" não tem soma de dados possível aqui (canal vetorial) —
      // compõe normal, como o modo "energy".
      pp.style.mixBlendMode = (blend === "energy" || blend === "sum-data") ? "normal" : blend;
    }
  }
  // Reference geometry (GPX overlay): a simple show/hide toggle (no opacity).
  if (state.refTrackLayer) {
    const visible = document.getElementById("refgeom-visible")?.checked ?? true;
    if (visible && !map.hasLayer(state.refTrackLayer)) state.refTrackLayer.addTo(map);
    else if (!visible && map.hasLayer(state.refTrackLayer)) state.refTrackLayer.remove();
  }
}

export function updateLegendTicks() {
  // Legend reflects the energy layer's mapping. Default auto = p1/p80
  // linear; user-pinned overrides either bound. Mid is the linear
  // midpoint of the value range (close-enough for any reasonable gamma).
  const lo = document.getElementById("legend-lo");
  const mid = document.getElementById("legend-mid");
  const hi = document.getElementById("legend-hi");
  if (!lo || !mid || !hi) return;
  const userMin = readRangeInput("vmin", null);
  const userMax = readRangeInput("vmax", null);
  const a = userMin != null ? userMin : (state.lastAutoMin ?? 0);
  const b = userMax != null ? userMax : (state.lastAutoMax ?? 1);
  lo.textContent = formatEnergy(a);
  mid.textContent = formatEnergy(0.5 * (a + b));
  hi.textContent = formatEnergy(b);
}

export function readRangeInput(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const raw = el.value.trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function isUserPinned(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  const raw = el.value.trim();
  if (raw === "") return false;
  const n = Number(raw);
  return Number.isFinite(n);
}

export function syncRangePlaceholders() {
  const lo = document.getElementById("vmin");
  const hi = document.getElementById("vmax");
  if (lo && state.lastAutoMin != null) lo.placeholder = formatEnergy(state.lastAutoMin);
  if (hi && state.lastAutoMax != null) hi.placeholder = formatEnergy(state.lastAutoMax);
  // Passes absolute inputs — placeholders show the auto bounds.
  const pLo = document.getElementById("passes-vmin");
  const pHi = document.getElementById("passes-vmax");
  if (pLo && state.lastPassesAutoMin != null) pLo.placeholder = formatSci(state.lastPassesAutoMin);
  if (pHi && state.lastPassesAutoMax != null) pHi.placeholder = formatSci(state.lastPassesAutoMax);
}
