// Cloud compute: the VM state machine (start, keep-alive, stop).
import "./engines.js"; // evaluation order — see ../app.js
import { t } from "./i18n.js";
import { state } from "./state.js";
import {
  CLOUD_MACHINE_SPECS, cloudClientId, cloudMachineType, cloudToken,
} from "./compute-source.js";
import { status } from "./dom.js";
import { formatDuration } from "./estimate.js";

// ---- Cloud VM state machine ---------------------------------------------
// Drives the orchestrator (a public Cloud Run service) that fronts a
// pre-baked compute VM. The RUN path calls ensureCloudVm() before dispatching
// the (unchanged) backend density/single fetch against the orchestrator URL.
// The client-side keepalive marks "compute in flight" while a compute runs
// (its /cloud/keepalive traffic is a no-op on the orchestrator — the real
// cost backstop is the in-VM idle-watchdog + uptime cap); the VM is stopped
// after each run and on tab hide (a "stop VM after each run" default-ON
// behaviour). All status text goes through t(); the hint line lives in
// #cloud-vm-status.
const CLOUD_POLL_MS = 3000;       // /cloud/status poll cadence while booting
const CLOUD_KEEPALIVE_MS = 60000; // client-side keepalive cadence while computing
const CLOUD_BOOT_TIMEOUT_MS = 300000; // give the VM up to 5 min to go healthy

export function setCloudHint(key, ...args) {
  const el = document.getElementById("cloud-vm-status");
  if (el) el.textContent = key ? t(key, ...args) : "";
}

// POST/GET helpers with a short timeout. Throw on transport failure (caller
// maps that to a fallback); a non-ok HTTP status throws too.
async function cloudFetchJson(url, { method = "GET", timeoutMs = 8000, body = null } = {}) {
  const headers = {};
  const tok = cloudToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  let payload;
  if (body != null) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const resp = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) {
    const e = new Error(`cloud HTTP ${resp.status}`);
    e.status = resp.status;          // lets callers distinguish 401 (bad password)
    throw e;
  }
  return resp.json();
}

// Ensure the cloud VM is up, then cache its core count from the data-plane
// /health. Resolves true on ready; throws (reason: orch_unreachable /
// auth_failed / boot_failed) so the caller falls back to the browser.
// `isStale` lets a superseded run bail out of the poll loop.
export async function ensureCloudVm(orchUrl, isStale) {
  // Kick the (idempotent) start/create on the CONTROL plane (orchestrator).
  // machineType: the #cloud-machine selection — applied by the orchestrator
  // when the VM is created or started from STOPPED; a VM already RUNNING
  // keeps its size until the next stop (the response reports the actual type).
  let started;
  try {
    // 45 s: o start pode bloquear no resize síncrono (set_machine_type +
    // set_metadata, ~11 s medidos no n2-8; máquinas maiores/ops lentas passam
    // de 15 s) — um timeout curto aborta e cai pro navegador sem necessidade.
    started = await cloudFetchJson(`${orchUrl}/cloud/start`, {
      method: "POST", timeoutMs: 45000,
      body: { machineType: cloudMachineType() },
    });
  } catch (err) {
    state.cloud.vmState = "ERROR";
    if (err.status === 401) throw Object.assign(new Error("auth_failed"), { reason: "auth_failed", cause: err });
    throw Object.assign(new Error("orch_unreachable"), { reason: "orch_unreachable", cause: err });
  }
  state.cloud.vmState = started.state || "PROVISIONING";
  // Data plane: the VM's HTTPS host — compute + health go DIRECT here.
  const dataUrl = (started.dataUrl || "").replace(/\/+$/, "");
  state.cloud.dataUrl = dataUrl;
  if (!dataUrl) throw Object.assign(new Error("boot_failed"), { reason: "boot_failed" });

  const etaS = Number.isFinite(started.etaSeconds) ? started.etaSeconds : 60;
  // A from-scratch CREATE (no instance yet → ETA ≥ 3 min: startup-script + a
  // fresh DNS-01 cert) reads differently from a warm start, and needs a timeout
  // bigger than the 5-min default.
  const hint = etaS >= 180 ? "cloud.creating" : "cloud.starting";
  setCloudHint(hint, formatDuration(etaS * 1000));
  status.textContent = t(hint, formatDuration(etaS * 1000));
  // A from-scratch CREATE can fall back to compiling the Rust backend from
  // source (~10 min) when the operator hasn't published BACKEND_BINARY_URL —
  // widen the multiplier for that long-boot case so the client doesn't give
  // up mid-build (the same etaS>=180 threshold that picks the "creating" hint).
  const deadline = performance.now() + Math.max(CLOUD_BOOT_TIMEOUT_MS, etaS * (etaS >= 180 ? 5 : 2) * 1000);

  // Poll the DATA-plane /health directly: the orchestrator opened the firewall
  // to our IP and pointed DNS at the VM, so once it answers 200+ok the VM is
  // RUNNING, the backend is up, and the TLS cert is ready. A transport error
  // means not-ready-yet (DNS propagating / cert issuing / boot) — keep waiting.
  for (;;) {
    if (isStale && isStale()) return false;
    let h = null;
    try {
      h = await cloudFetchJson(`${dataUrl}/health`, { method: "GET", timeoutMs: 8000 });
    } catch (err) {
      if (err.status === 401) throw Object.assign(new Error("auth_failed"), { reason: "auth_failed", cause: err });
      h = null; // not reachable yet — keep polling
    }
    if (h && h.ok) {
      state.cloud.vmState = "RUNNING";
      // cores/mem_budget_bytes (snake_case from the Rust /health) feed the
      // estimate's slice model immediately.
      if (Number.isFinite(h.cores)) {
        state.backendCores = {
          url: dataUrl, cores: h.cores,
          memBudgetBytes: Number.isFinite(h.mem_budget_bytes) ? h.mem_budget_bytes : null,
          version: typeof h.version === "string" ? h.version : null,
        };
      }
      // Keep-warm + a size change in the dropdown: the running VM keeps its
      // size until the next boot — say so instead of a silent mismatch (the
      // estimate models the SELECTION, so estimate and run would disagree).
      const selSpec = CLOUD_MACHINE_SPECS[cloudMachineType()];
      if (Number.isFinite(h.cores) && selSpec && selSpec.cores !== h.cores) {
        setCloudHint("cloud.size_mismatch", h.cores, selSpec.cores);
      } else {
        setCloudHint("cloud.ready", Number.isFinite(h.cores) ? h.cores : "?");
      }
      return true;
    }
    // Occasionally check the control plane for a hard ERROR (don't fail on a
    // transient status hiccup — the /health poll above is the real readiness gate).
    try {
      const st = await cloudFetchJson(`${orchUrl}/cloud/status`, { method: "GET", timeoutMs: 8000 });
      state.cloud.vmState = st.state || state.cloud.vmState;
      if (st.state === "ERROR") throw Object.assign(new Error("boot_failed"), { reason: "boot_failed" });
      // The instance can land STOPPED (or ABSENT) while we're polling: the
      // default "stop VM after each run" behaviour means a run started right
      // after the previous one's STOPPING window completes lands exactly
      // here, and nobody would otherwise re-issue /cloud/start — the VM would
      // sit stopped until this loop's boot_failed deadline. /cloud/start is
      // documented idempotent (creates if absent, starts if stopped, no-op if
      // running), so re-kicking it is safe.
      if (st.state === "STOPPED" || st.state === "ABSENT") {
        try {
          await cloudFetchJson(`${orchUrl}/cloud/start`, {
            method: "POST", timeoutMs: 45000,
            body: { machineType: cloudMachineType() },
          });
        } catch (startErr) {
          if (startErr.status === 401) {
            throw Object.assign(new Error("auth_failed"), { reason: "auth_failed", cause: startErr });
          }
          /* transient — the next poll iteration will retry */
        }
      }
    } catch (err) {
      if (err.reason === "boot_failed" || err.reason === "auth_failed") throw err;
      if (err.status === 401) throw Object.assign(new Error("auth_failed"), { reason: "auth_failed", cause: err });
      /* transient orchestrator hiccup — keep waiting */
    }
    if (performance.now() > deadline) throw Object.assign(new Error("boot_failed"), { reason: "boot_failed" });
    await new Promise((r) => setTimeout(r, CLOUD_POLL_MS));
  }
}

// Client-side keepalive: marks "a cloud compute is in flight" for the
// duration of the run (it's beaconStopCloudVm's in-flight signal). Its
// /cloud/keepalive traffic ALSO registers/renews this tab's short-lived
// orchestrator lease (X-Simu-Client → LEASES[clientId], ~180s TTL) so a
// concurrent second browser's default "stop after run" can't kill the VM
// out from under this run. The in-VM idle-watchdog (~15 min) + uptime cap
// remain the real cost backstops regardless of any lease. Cleared by
// stopCloudKeepalive().
export function startCloudKeepalive(orchUrl) {
  stopCloudKeepalive();
  const tok = cloudToken();
  const headers = { "X-Simu-Client": cloudClientId() };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  state.cloud.keepaliveTimer = setInterval(() => {
    fetch(`${orchUrl}/cloud/keepalive`, { method: "POST", headers, signal: AbortSignal.timeout(8000) })
      .catch(() => { /* best-effort — the in-VM watchdog reaps regardless */ });
  }, CLOUD_KEEPALIVE_MS);
}
export function stopCloudKeepalive() {
  if (state.cloud.keepaliveTimer) { clearInterval(state.cloud.keepaliveTimer); state.cloud.keepaliveTimer = null; }
}

// Stop the VM now (default-ON "stop after each run"). Best-effort: a POST with
// a short timeout from the in-page path, or a sendBeacon from a page-hide
// handler (which can't await). Always clears the keepalive first. Carries
// X-Simu-Client so the orchestrator can skip the stop if another client's
// lease (from ITS keepalive) is still active — see LEASES in orchestrator/main.py.
export function stopCloudVm(orchUrl, { beacon = false } = {}) {
  stopCloudKeepalive();
  if (!orchUrl) return;
  const tok = cloudToken();
  const headers = { "X-Simu-Client": cloudClientId() };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (beacon) {
    // On page-hide we can't await; fetch({keepalive:true}) survives the unload
    // AND carries the Authorization/X-Simu-Client headers (sendBeacon CAN'T set
    // headers, so the orchestrator would 401 it or lose the lease check). Best-effort.
    try { fetch(`${orchUrl}/cloud/stop`, { method: "POST", headers, keepalive: true }); }
    catch { /* best-effort */ }
    state.cloud.vmState = "STOPPING";
    return;
  }
  setCloudHint("cloud.stopping");
  state.cloud.vmState = "STOPPING";
  fetch(`${orchUrl}/cloud/stop`, { method: "POST", headers, signal: AbortSignal.timeout(8000) })
    .then((resp) => resp.json().catch(() => ({})))
    .then((body) => {
      // A concurrent client's active lease makes the orchestrator SKIP the
      // stop and report the VM's real (still-running) state — reflect that
      // instead of claiming STOPPED, or this tab's UI would lie.
      if (body && body.skipped) {
        state.cloud.vmState = body.state || "RUNNING";
        setCloudHint("cloud.stop_skipped");
      } else {
        state.cloud.vmState = "STOPPED";
        setCloudHint("cloud.stopped_after");
      }
    })
    .catch(() => { /* best-effort — the in-VM watchdog reaps it anyway */ });
}
