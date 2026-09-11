// Worker-thread host for the DEM load. geotiff decoding and the σ 30 m
// pre-smoothing are CPU-bound (~20 s on a 135 M-cell DEM); running them here
// keeps the MCP main thread answering pings, reporting progress and honouring
// cancellation (terminate), exactly like engine-thread.mjs does for computes.
// It reuses lib.mjs's loadDemSmoothed — the auto-σ rule is NOT re-implemented.
import { parentPort, workerData } from "node:worker_threads";

// stdout is the parent's JSON-RPC wire — keep every console channel off it.
for (const k of ["log", "info", "debug", "warn", "trace"]) console[k] = (...a) => console.error(...a);

const { loadDemSmoothed } = await import("./lib.mjs");
try {
  const dem = await loadDemSmoothed(workerData.path, {
    label: workerData.label,
    smooth: workerData.smooth,
    onStage: (stage) => parentPort.postMessage({ kind: "stage", stage }),
  });
  parentPort.postMessage({ kind: "done", dem }, [dem.height.buffer, dem.mask.buffer]);
} catch (err) {
  parentPort.postMessage({ kind: "error", message: err?.message || String(err) });
}
