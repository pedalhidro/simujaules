// lib/pool-merge.js — arrival-order-independent merge of the density pool's
// slices. Pure (no DOM, no state); shared by app/run.js and test-pool-merge.mjs.
//
// Each density-pool worker returns raw accumulators (densityPartial: density,
// energySum, energyCount) for its slice of reference points. Floating-point
// addition is not associative, so summing slices AS THEY ARRIVE makes the
// totals depend on worker timing once a pool has ≥ 3 slices (with 1 or 2 the
// sum is 0+a or 0+a+b = 0+b+a, i.e. stable). The merger below always adds
// slices in SLOT order (0, 1, …, P−1): a slice that arrives early is held
// until every lower slot has been merged, then drained. Same inputs → same
// bits, however the workers finish.

// createSlotMerger({ slots, onMerge }) — onMerge(slot, data) is called
// exactly once per slot, in increasing slot order. add(slot, data) returns
// true once every slot has been merged. A held slot's reference is cleared
// the moment it is merged; drop() releases everything still held (cancel /
// error) and makes further add() calls no-ops.
export function createSlotMerger({ slots, onMerge }) {
  let held = new Array(slots).fill(null);
  let next = 0;        // lowest slot not yet merged
  let heldCount = 0;
  let dropped = false;
  return {
    add(slot, data) {
      if (dropped || !(slot >= next && slot < slots) || held[slot] !== null) return next === slots;
      if (slot !== next) {
        held[slot] = data;
        heldCount++;
        return false;
      }
      onMerge(slot, data);
      next++;
      while (next < slots && held[next] !== null) {
        const d = held[next];
        held[next] = null;   // release before merging: nothing pins it afterwards
        heldCount--;
        onMerge(next, d);
        next++;
      }
      return next === slots;
    },
    drop() {
      dropped = true;
      held.fill(null);
      heldCount = 0;
    },
    get merged() { return next; },
    get heldCount() { return heldCount; },
    get done() { return next === slots; },
    // Test hook: the live references still held (null = released).
    _held() { return held; },
  };
}

// The density pool's per-slice accumulation: acc += part, element-wise, for
// density (f64 total of f32/f64 slices), energySum (f64) and energyCount
// (i32 total of i32/u32 slices). Order-sensitive by nature — call it through
// createSlotMerger.
export function addDensityPartial(acc, part) {
  const { density, energySum, energyCount } = acc;
  const N = density.length;
  const pd = part.density, pe = part.energySum, pc = part.energyCount;
  for (let i = 0; i < N; i++) density[i] += pd[i];
  for (let i = 0; i < N; i++) energySum[i] += pe[i];
  for (let i = 0; i < N; i++) energyCount[i] += pc[i];
}
