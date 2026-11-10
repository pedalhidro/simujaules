// Compute source (Browser / Localhost / Cloud): URLs, headers,
// cancelActiveCompute(), wedged-compute recovery.
import "./state.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { escapeHtml, state } from "./state.js";
import { progress, status } from "./dom.js";
import { updateRunButtonState } from "./points.js";
import { clearMaxseg } from "./maxseg.js";
import { stopCloudKeepalive, stopCloudVm } from "./cloud.js";

// ---- Compute-source indirection (Browser / Localhost / Cloud) -----------
// The single source of truth for which engine a run uses. `computeMode()`
// reads the selector radios; `effectiveBackendUrl()` maps Localhost→backend
// URL and Cloud→orchestrator URL (both trimmed, trailing slashes stripped).
// Everything downstream (startDensityBackend / startSingleBackend / the binary
// frame builders / the /health probe) is engine-agnostic — it just receives
// the right base URL. The orchestrator mirrors the Rust backend's /density,
// /single, /health byte-for-byte, so Cloud is an opaque pass-through.
export function computeMode() {
  return document.querySelector('input[name="compute-source"]:checked')?.value || "browser";
}
export function effectiveBackendUrl() {
  const cloud = computeMode() === "cloud";
  // Localhost keeps the historical default (an empty field → the standard
  // backend port). Cloud has no safe default — an empty orchestrator URL blocks
  // the run with cloud.need_orch_url rather than guessing.
  const id = cloud ? "orchestrator-url" : "backend-url";
  const raw = (document.getElementById(id)?.value || "").trim();
  let val = (!cloud && !raw) ? "http://127.0.0.1:8077" : raw;
  // A pasted bare hostname ("simu-orch….run.app") is a RELATIVE URL to fetch()
  // — the POST goes to the app's own origin and fails confusingly (visto na
  // prática contra um dev-server local). Assume https:// when the scheme is
  // missing; loopback hosts get http:// (the native backend has no TLS).
  if (val && !/^[a-z][a-z0-9+.-]*:\/\//i.test(val)) {
    val = (/^(127\.0\.0\.1|localhost|\[::1\])(:|$|\/)/.test(val) ? "http://" : "https://") + val;
  }
  return val.replace(/\/+$/, "");
}
// Kept for reference; Cloud now works from ANY origin (the orchestrator is a
// public Cloud Run service, not loopback), so this no longer gates the radio.
function isLocalOrigin() {
  if (location.protocol === "file:") return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

// Cloud splits into TWO planes: the CONTROL plane is the orchestrator URL
// (effectiveBackendUrl, Cloud Run) — start/stop/status; the DATA plane is the
// VM's HTTPS host (state.cloud.dataUrl, learned from the orchestrator) — where
// the big /density,/single,/health requests go DIRECT (Cloud Run can't proxy
// them: 32 MiB limit). Localhost uses one URL for both. computeDataUrl() is
// what the compute fetches target.
export function computeDataUrl() {
  if (computeMode() === "cloud" && state.cloud.dataUrl) return state.cloud.dataUrl;
  return effectiveBackendUrl();
}
// The shared cloud password (Bearer token), from the #cloud-token field. The
// SAME token gates the orchestrator (control) and Caddy on the VM (data).
export function cloudToken() {
  return (document.getElementById("cloud-token")?.value || "").trim();
}
// The requested cloud VM size (#cloud-machine). The orchestrator validates
// against its own allowlist and applies it on create / on start-from-stopped.
export function cloudMachineType() {
  return document.getElementById("cloud-machine")?.value || "n2-standard-8";
}
// "Falhar em vez de cair pro navegador": a cloud failure aborts the run loudly
// instead of silently recomputing on the laptop (which on a big DEM looks like
// a hang and HIDES the cloud problem — the failure mode of choice all night).
export function cloudNoFallback() {
  return !!document.getElementById("cloud-no-fallback")?.checked;
}
// cores + backend memory budget per selectable size — mirrors the orchestrator's
// ALLOWED_MACHINE_TYPES max-mem-gb table × the backend's 0.8 effective factor
// (density_mem_budget_bytes em backend/src/main.rs). Used by the time estimate
// so it tracks the DROPDOWN (the next boot applies it), not the last VM booted.
export const CLOUD_MACHINE_SPECS = {
  "n2-standard-8":   { cores: 8,   memBudgetBytes: 28 * 0.8e9 },
  "n2-standard-32":  { cores: 32,  memBudgetBytes: 115 * 0.8e9 },
  "n2-standard-128": { cores: 128, memBudgetBytes: 460 * 0.8e9 },
};
// Backend spec the ESTIMATE should assume. Cloud: the selected machine (a
// running keep-warm VM of another size is transient — default is stop-after-
// run, so the next compute boots the selected size). Localhost: the cached
// /health probe (nulls → the caller's fallbacks).
export function backendSpecForEstimate() {
  if (computeMode() === "cloud") {
    const spec = CLOUD_MACHINE_SPECS[cloudMachineType()];
    if (spec) return spec;
  }
  return {
    cores: state.backendCores ? state.backendCores.cores : null,
    memBudgetBytes: state.backendCores ? state.backendCores.memBudgetBytes : null,
  };
}
// Headers for a Cloud data-plane compute request: the Bearer token + an opt-in
// asking the backend to gzip its (large) response (the browser auto-inflates).
// Empty for Localhost (the native backend has no auth).
export function cloudComputeHeaders() {
  if (computeMode() !== "cloud") return {};
  const h = { "X-Simu-Gzip": "1" };
  const tok = cloudToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

// Stable per-tab id sent as X-Simu-Client to /cloud/keepalive and /cloud/stop
// so the orchestrator's lease can tell this browser apart from a concurrent
// one (see LEASES in orchestrator/main.py) — generated once, lazily, so a
// session that never touches Cloud never allocates a UUID for nothing.
export function cloudClientId() {
  if (!state.cloud.clientId) state.cloud.clientId = crypto.randomUUID();
  return state.cloud.clientId;
}

// Terminate every in-flight compute worker and invalidate their pending
// messages via the generation bump. Safe to call when idle. Must run before
// anything that changes the grid a result would be rendered against (DEM
// load, network load/clear) — see state.computeGen above.
export function cancelActiveCompute() {
  state.computeGen++;
  for (const w of state.workers) w.terminate();
  state.workers = [];
  clearMaxseg(); // derived from the result/grid this cancellation invalidates
  // A superseded cloud run must stop its keepalive traffic — /cloud/keepalive
  // extends this tab's short-lived orchestrator lease (LEASES[clientId]),
  // which is what protects a concurrent second browser's compute from a
  // default "stop after run"; letting a dead run's keepalive linger would
  // needlessly hold that lease. The in-VM idle-watchdog + uptime cap remain
  // the real cost backstops regardless of any lease.
  stopCloudKeepalive();
  if (state.computeStartedAt) {
    state.computeStartedAt = 0;
    progress.classList.remove("active");
    updateRunButtonState();
  }
}

// Last-resort safety net for the async compute dispatch. A SYNCHRONOUS throw
// inside the dispatch bodies (e.g. an OOM allocating buildComputeGrid()/the
// DEM payload on a 135 M-cell grid) escapes as an unhandled rejection that
// would otherwise leave the progress bar spinning, the Run button disabled,
// and "Computing…" stuck — forcing a manual reload. Only act when a compute
// is actually in flight, so unrelated errors don't clobber the UI.
function handleWedgedCompute(detail) {
  if (!state.computeStartedAt) return;
  console.error("[compute] unhandled failure while running:", detail);
  cancelActiveCompute();
  // Run encalhado na nuvem: libera a VM (cancelActiveCompute só corta o
  // keepalive, não desliga a instância).
  if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
    stopCloudVm(state.cloud.orchestratorUrl);
  }
  const msg = (detail && detail.message) || String(detail || "unknown error");
  status.innerHTML =
    `<span style="color:#ff6b6b">${t("status.compute_failed", escapeHtml(msg))}</span>`;
}
window.addEventListener("unhandledrejection", (e) => handleWedgedCompute(e.reason));
window.addEventListener("error", (e) => handleWedgedCompute(e.error || e.message));

// Cloud: if the tab is hidden or unloaded while a cloud VM is up AND IDLE, stop
// it now (default-ON "stop after each run", extended to the leave-the-page case)
// via a fire-and-forget sendBeacon — a normal fetch wouldn't survive the unload.
// NEVER stop a VM that's mid-compute: visibilitychange→hidden fires on an
// ordinary tab switch / minimize / screen lock, and stopping then would abort
// the in-flight remote run (the stream-proxy fetch drops → it falls back to the
// far slower / OOM-prone browser pool, losing the whole run). keepaliveTimer is
// the precise "a run is in flight" signal — its /cloud/keepalive traffic also
// extends this tab's orchestrator lease, so a hidden tab's OWN dead run can't
// out-live it either. If the tab truly dies mid-run, the in-VM idle-watchdog
// (~15 min) + uptime cap are the only backstops.
function beaconStopCloudVm() {
  if (state.cloud.keepaliveTimer) return; // a compute is running — leave the VM alone
  if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {
    stopCloudVm(state.cloud.orchestratorUrl, { beacon: true });
  }
}
document.addEventListener("visibilitychange", () => {
  // Em modo "manter VM ligada", trocar/esconder a aba NÃO desliga a VM (o
  // watchdog de ócio DENTRO da VM cuida disso — /cloud/keepalive renova o
  // lease deste cliente no orquestrador, mas não é o que decide manter a VM
  // ligada); só um unload real
  // (pagehide) desliga. Sem keep-warm, esconder a aba desliga a VM ociosa
  // (economia padrão). state.computeStartedAt is set BEFORE the cloud dispatch
  // (i.e. already nonzero during VM boot, before startCloudKeepalive() arms
  // keepaliveTimer) — checking it here, not just keepaliveTimer, keeps a
  // hidden tab from stopping the VM mid-boot and dooming the run.
  if (document.visibilityState === "hidden"
      && !state.computeStartedAt
      && !document.getElementById("cloud-keep-warm")?.checked) {
    beaconStopCloudVm();
  }
});
window.addEventListener("pagehide", beaconStopCloudVm);
