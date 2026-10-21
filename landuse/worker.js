// Runs the land-use model off the page's main thread. The page decodes the
// baked layers once, hands them over with `init`, then posts `run` with the
// slider values; every result carries the request id so the page can drop
// stale answers when the sliders moved on.
import { prepare, simulate } from "./model.js";

let ctx = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.kind === "init") {
      ctx = prepare(m.meta, m.files);
      self.postMessage({ kind: "ready" });
    } else if (m.kind === "run") {
      const r = simulate(ctx, m.params);
      self.postMessage(
        { kind: "result", id: m.id, params: r.params, use: r.use, flags: r.flags, cityPop: r.cityPop, networks: r.networks, points: r.points, stats: r.stats },
        [r.use.buffer, r.flags.buffer, r.cityPop.buffer],
      );
    }
  } catch (err) {
    self.postMessage({ kind: "error", id: m.id, message: String((err && err.stack) || err) });
  }
};
