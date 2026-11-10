// Accessibility KPIs (3B) from the ref↔ref energy matrix, and their CSV exports.
import "./run.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { state } from "./state.js";
import { kpiInvalidate, makeRefIcon } from "./points.js";

// ---- Accessibility KPIs (300 kJ initiative) --------------------------------
// state.kpi caches the pairwise matrix from the last density run in OUTBOUND
// row form: mat[i*K + j] = energy of ref i's trip to ref j under the run's
// mode ("from": i→j; raw "to" rows hold e(j→i) and are transposed once at
// install; "round": the masked round-trip total). count_i(E) =
// |{j : mat[i*K+j] ≤ E}| — self included, a ref always reaches its own share.
// With census sampling every ref proxies popM/K people, so
//   KPI 1 = % of refs with (popM/K)·count_i(E₁) ≥ K_people   (needs M)
//   KPI 2 = % of refs with count_i(E₂)/K ≥ J/100             (M-free)
// and "% of refs" reads as "% of population" because the sampling itself is
// population-weighted. A threshold is EXACT iff the run had no budget or the
// threshold ≤ eMax; beyond that the matrix is budget-truncated and the KPIs
// are lower bounds (the block warns). Threshold edits re-evaluate the cached
// matrix only — like the style knobs, they must never trigger a recompute.

export function installKpiResult(matrix, snap, outdated) {
  if (!matrix || !snap) {
    if (outdated && snap) {
      // The native backend predates the matrix: keep the block visible with
      // the hint instead of silently hiding the feature.
      state.kpi = {
        unavailable: true, mat: null, K: snap.refs.length, refs: snap.refs,
        popM: snap.popM, eMax: snap.eMax, eMaxMode: snap.eMaxMode, mode: snap.mode,
        refsMatch: false,
      };
      renderKpiBlock();
      return;
    }
    kpiInvalidate();
    return;
  }
  const K = snap.refs.length;
  let mat = matrix;
  if (snap.mode === "to") {
    mat = new Float32Array(K * K);
    for (let i = 0; i < K; i++)
      for (let j = 0; j < K; j++) mat[i * K + j] = matrix[j * K + i];
  }
  // Marker recoloring is only valid while the on-map refs still ARE the
  // run's refs — a mid-run ref edit already invalidated once, but the
  // arriving result re-installs against its own snapshot.
  const refsMatch = state.refPoints.length === K &&
    state.refPoints.every(([r, c], i) => snap.refs[i].r === r && snap.refs[i].c === c);
  state.kpi = {
    mat, K, refs: snap.refs, popM: snap.popM,
    eMax: snap.eMax, eMaxMode: snap.eMaxMode, mode: snap.mode, refsMatch,
  };
  // Prefill M from the census proxy; editable (non-census sampling needs a
  // hand-entered M for KPI 1 — KPI 2 works without one).
  const popInput = document.getElementById("kpi-pop");
  if (popInput) popInput.value = snap.popM != null ? String(Math.round(snap.popM)) : "";
  const popLabel = document.getElementById("kpi-pop-label");
  if (popLabel) {
    popLabel.setAttribute("data-i18n", snap.popM != null ? "kpi.pop_census" : "kpi.pop");
    popLabel.textContent = t(snap.popM != null ? "kpi.pop_census" : "kpi.pop");
  }
  renderKpiBlock();
}

// count_i(E) over the outbound matrix — one O(K²) pass per threshold.
function kpiCounts(mat, K, E) {
  const counts = new Int32Array(K);
  for (let i = 0; i < K; i++) {
    let n = 0;
    const row = i * K;
    for (let j = 0; j < K; j++) if (mat[row + j] <= E) n++;
    counts[i] = n;
  }
  return counts;
}

// Current KPI inputs (initiative defaults live in index.html), resolved M
// (census prefill or hand-entered), and both per-ref count vectors. Shared
// by the renderer and the CSV exports so they can never disagree.
function kpiEval() {
  const kpi = state.kpi;
  if (!kpi || kpi.unavailable) return null;
  const num = (id, dflt) => {
    const v = parseFloat(document.getElementById(id)?.value);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  const eK = num("kpi-ek", 200);
  const kPeople = num("kpi-k", 1_000_000);
  const eJ = num("kpi-ej", 600);
  const jPct = Math.min(100, num("kpi-j", 80));
  const popRaw = parseFloat(document.getElementById("kpi-pop")?.value);
  const popM = Number.isFinite(popRaw) && popRaw > 0 ? popRaw : null;
  // Grid-bias correction (research note §10): inflate the thresholds by c —
  // equivalent to deflating the 8-grid's overestimated energies by a shared
  // constant. 1 = off (the conservative-floor default). Counting only; the
  // displayed threshold values stay what the user typed.
  const corrRaw = parseFloat(document.getElementById("kpi-corr")?.value);
  const corr = Number.isFinite(corrRaw) ? Math.min(1.5, Math.max(1, corrRaw)) : 1;
  const { mat, K } = kpi;
  const c1 = kpiCounts(mat, K, eK * corr);
  const c2 = kpiCounts(mat, K, eJ * corr);
  let pass1 = 0, pass2 = 0;
  const perRef = popM != null ? popM / K : 0;
  for (let i = 0; i < K; i++) {
    if (popM != null && perRef * c1[i] >= kPeople) pass1++;
    if (c2[i] / K >= jPct / 100 - 1e-12) pass2++;
  }
  return { eK, kPeople, eJ, jPct, popM, corr, c1, c2, pass1, pass2, K };
}

function renderKpiBlock() {
  const group = document.getElementById("kpi-group");
  if (!group) return;
  const kpi = state.kpi;
  if (!kpi) { group.style.display = "none"; return; }
  group.style.display = "";
  const out1 = document.getElementById("kpi-out1");
  const out2 = document.getElementById("kpi-out2");
  const metaEl = document.getElementById("kpi-meta");
  const warnEl = document.getElementById("kpi-warn");
  if (kpi.unavailable) {
    if (out1) out1.textContent = "—";
    if (out2) out2.textContent = "—";
    if (metaEl) metaEl.textContent = "";
    if (warnEl) { warnEl.textContent = t("kpi.backend_no_matrix"); warnEl.style.display = ""; }
    return;
  }
  const ev = kpiEval();
  if (!ev) return;
  const pct = (n) => (100 * n / ev.K).toFixed(1);
  if (out1) {
    out1.innerHTML = ev.popM != null
      ? t("kpi.out1", pct(ev.pass1), Math.round(ev.kPeople).toLocaleString(), ev.eK)
      : t("kpi.out1_need_pop");
  }
  if (out2) out2.innerHTML = t("kpi.out2", pct(ev.pass2), ev.jPct, ev.eJ);
  if (metaEl) {
    const budget = kpi.eMax > 0 ? `${kpi.eMax} kJ${kpi.mode === "round" ? ` (${kpi.eMaxMode})` : ""}` : t("kpi.meta_no_budget");
    let s = t("kpi.meta", kpi.K, kpi.mode, budget);
    if (!kpi.refsMatch) s += `<br/>${t("kpi.refs_changed")}`;
    metaEl.innerHTML = s;
  }
  if (warnEl) {
    const msgs = [];
    if (kpi.eMax > 0 && (ev.eK * ev.corr > kpi.eMax || ev.eJ * ev.corr > kpi.eMax)) {
      msgs.push(t("kpi.warn_budget", kpi.eMax));
    }
    if (ev.corr > 1) msgs.push(t("kpi.corr_note", ev.corr.toFixed(2)));
    warnEl.textContent = msgs.join(" ");
    warnEl.style.display = msgs.length ? "" : "none";
  }
  kpiRecolorMarkers(ev);
}

// Color each ref marker by its accessible population, on a red→yellow→green
// ramp anchored at the KPI-1 threshold (yellow = exactly the target; without
// an M, anchored at the KPI-2 J% target instead). Tooltips carry the number.
function kpiLerpHex(a, b, f) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * f).toString(16).padStart(2, "0")).join("");
}
function kpiRecolorMarkers(ev) {
  const kpi = state.kpi;
  if (!kpi || !kpi.refsMatch) return;
  for (let i = 0; i < kpi.K && i < state.refMarkers.length; i++) {
    const marker = state.refMarkers[i];
    if (!marker) continue;
    // v = attainment vs the anchor target (1 = exactly on target), clamped 2×.
    const v = ev.popM != null
      ? Math.min(2, (ev.popM / kpi.K) * ev.c1[i] / Math.max(1, ev.kPeople))
      : Math.min(2, (ev.c1[i] / kpi.K) / Math.max(1e-9, ev.jPct / 100));
    const color = v <= 1 ? kpiLerpHex("#d73027", "#fee08b", v) : kpiLerpHex("#fee08b", "#1a9850", v - 1);
    marker.setIcon(makeRefIcon(i + 1, color));
    const tip = ev.popM != null
      ? t("kpi.marker_tooltip", i + 1, Math.round((ev.popM / kpi.K) * ev.c1[i]).toLocaleString(), ev.eK)
      : t("kpi.marker_tooltip_frac", i + 1, (100 * ev.c1[i] / kpi.K).toFixed(1), ev.eK);
    marker.unbindTooltip().bindTooltip(tip);
  }
}

// ---- KPI CSV exports (blob-download, mirrors exportRefPoints) --------------
function kpiDownload(name, text, type = "text/csv") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function kpiExportRefsCsv() {
  const kpi = state.kpi;
  const ev = kpiEval();
  if (!kpi || !ev) return;
  const num = (v) => (v == null ? "" : v);
  const lines = [
    `# simujaules accessibility — per-reference table`,
    `# K=${kpi.K} mode=${kpi.mode} eMax_kJ=${kpi.eMax}${kpi.mode === "round" ? ` eMaxMode=${kpi.eMaxMode}` : ""} M=${num(ev.popM)} E1_kJ=${ev.eK} K_people=${ev.kPeople} E2_kJ=${ev.eJ} J_pct=${ev.jPct} grid_corr=${ev.corr}`,
    `index,row,col,lat,lng,count_E1,acc_pop_E1,frac_refs_E1,kpi1_pass,count_E2,frac_refs_E2,kpi2_pass`,
  ];
  const perRef = ev.popM != null ? ev.popM / kpi.K : null;
  for (let i = 0; i < kpi.K; i++) {
    const rf = kpi.refs[i];
    lines.push([
      i + 1, rf.r, rf.c,
      rf.lat != null ? rf.lat.toFixed(6) : "", rf.lng != null ? rf.lng.toFixed(6) : "",
      ev.c1[i],
      perRef != null ? Math.round(perRef * ev.c1[i]) : "",
      (ev.c1[i] / kpi.K).toFixed(4),
      perRef != null ? (perRef * ev.c1[i] >= ev.kPeople ? 1 : 0) : "",
      ev.c2[i],
      (ev.c2[i] / kpi.K).toFixed(4),
      ev.c2[i] / kpi.K >= ev.jPct / 100 - 1e-12 ? 1 : 0,
    ].join(","));
  }
  kpiDownload("simujaules-access-refs.csv", lines.join("\n") + "\n");
}
function kpiExportMatrixCsv() {
  const kpi = state.kpi;
  if (!kpi || kpi.unavailable) return;
  const { mat, K } = kpi;
  const lines = [
    `# simujaules accessibility — outbound pairwise energy (kJ); empty = unreachable within the run budget`,
    "from\\to," + Array.from({ length: K }, (_, j) => j + 1).join(","),
  ];
  const row = new Array(K + 1);
  for (let i = 0; i < K; i++) {
    row[0] = i + 1;
    for (let j = 0; j < K; j++) {
      const v = mat[i * K + j];
      row[j + 1] = Number.isFinite(v) ? v.toFixed(3) : "";
    }
    lines.push(row.join(","));
  }
  kpiDownload("simujaules-access-matrix.csv", lines.join("\n") + "\n");
}

// Threshold edits re-evaluate the cached matrix live — never a recompute.
for (const id of ["kpi-ek", "kpi-k", "kpi-ej", "kpi-j", "kpi-pop", "kpi-corr"]) {
  document.getElementById(id)?.addEventListener("input", () => { if (state.kpi) renderKpiBlock(); });
}
document.getElementById("kpi-export-csv")?.addEventListener("click", kpiExportRefsCsv);
document.getElementById("kpi-export-matrix")?.addEventListener("click", kpiExportMatrixCsv);
