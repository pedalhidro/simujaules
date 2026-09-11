// Worker-thread host for energy-worker.js. The engine is a browser Web Worker
// script (it talks through `self.onmessage` / `postMessage`); this file gives
// it exactly that surface inside a node `worker_threads` Worker, so the MCP
// server's main thread stays responsive (progress notifications, cancellation
// by terminate) while a compute runs — the same one-Worker-per-run shape as
// app.js. It is the threaded twin of census-density.mjs's synchronous
// `loadWorker()` shim: same `new Function` evaluation, same message protocol.
//
// The engine's own `console` is redirected to stderr: in a worker thread
// console output is forwarded to the parent's stdio, and stdout is the MCP
// JSON-RPC wire — one stray line would corrupt it.
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

const src = readFileSync(workerData.enginePath, "utf8");
const self = {};
const postMessage = (m, transfer) => parentPort.postMessage(m, transfer || undefined);
const stderrConsole = {
  log: (...a) => console.error(...a),
  info: (...a) => console.error(...a),
  debug: (...a) => console.error(...a),
  warn: (...a) => console.error(...a),
  error: (...a) => console.error(...a),
};
new Function("postMessage", "self", "performance", "console", src)(
  postMessage, self, performance, stderrConsole,
);

parentPort.on("message", (data) => {
  try {
    self.onmessage({ data });
  } catch (err) {
    // Code before the engine's own try/catch (destructuring, move tables,
    // portal adjacency) throws synchronously — surface it as the same
    // `error` message the engine posts for failures inside the try.
    parentPort.postMessage({ kind: "error", message: err?.message || String(err) });
  }
});
