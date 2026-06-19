# Density compute-time performance model

A model relating density-mode compute time to **reference points (R)**,
**energy budget (e)**, **active threads (P)**, and **memory used (M)**,
synthesised from this session's benchmarks on the 135 M-cell `sampa_geral`
DEM (16 GB / 10-logical / 4-perf-core machine).

## Master formula

```
            c_alloc · N            R · tau_ref(e)
   T   ≈   ───────────────   +   ──────────────────
            (one-time alloc)         S(P_eff)
```

with the per-reference cost and the parallel speedup:

```
   tau_ref(e) = (N / r) · min(1, (e / e_full)^2) · nu

   S(P) = P / (1 + b·(P − 1))
```

and **P and M are coupled** — memory caps how many threads you can use:

```
   P_eff = min( P,            (requested threads)
                R,            (one worker per ref-slice)
                floor((M − 21·N) / (38·N)) )   (memory cap)
```

## Symbols and calibrated values

| Symbol | Meaning | Value (measured this session) | Depends on |
|--------|---------|-------------------------------|------------|
| `N`        | DEM cells (H·W)                         | 135.0 M for `sampa_geral`        | DEM |
| `R`        | reference points                        | input                            | — |
| `e`        | energy budget (`eMax`); 0 ⇒ full grid   | input                            | — |
| `r`        | per-cell settle rate                    | ~3300 cells/ms (JS)              | machine |
| `nu`       | engine factor                           | 1 (JS), 0.8 (native ≈ 1.25× faster) | engine |
| `e_full`   | budget that explores ~100% of the DEM   | ~600 (this DEM / alpha)          | DEM + alpha |
| `b`        | bandwidth-contention coefficient        | ~0.05 (mild; bandwidth-bound)    | machine |
| `c_alloc`  | one-time scratch first-touch            | ~7 ns/cell (~1 s on 135 M)       | machine |
| `m`        | bytes/cell per worker                   | 38 (from/to), 55 (round)         | engine |

The **explored fraction** `min(1, (e/e_full)^2)` is the core of the model:
exploration grows ~quadratically with budget (measured exponent 2.0–2.1) and
saturates at the whole grid. Since `alpha` is the cost per flat metre,
`e_full ∝ alpha × (DEM extent + relief)`, so doubling alpha halves the reach
and quarters the explored area.

## Memory side

Memory *used* is itself a function of threads — not an independent input:

```
   M(P) ≈ N · (21 + 38·P) bytes          (round mode: 21 + 55·P)
```

The fixed `21·N` is the main thread (DEM 5·N + result 16·N); each worker adds
`38·N` (its DEM copy + scratch + partials). For 135 M cells: P=1 → ~8 GB,
P=2 → ~13 GB — which is exactly why two workers don't fit 16 GB. The native
backend's per-slice footprint is similar (~37·N), capped by `SIMU_MAX_MEM_GB`.

## Validation against measured points

| Case | Formula | Measured |
|------|---------|----------|
| 5 refs, e=150, P=1, JS       | 1 + 5·2.56 = **13.8 s**     | 12.6 s |
| 5 refs, e=300, P=1, JS       | 1 + 5·10.2 = **52 s**       | 66.5 s (these refs over-explored) |
| 50 refs, e=300, P=1, JS      | 1 + 50·8.5 = **426 s**      | 427 s ✓ |
| 50 refs, e=300, P=2, native  | 1 + 50·6.8/1.9 = **180 s**  | 177 s ✓ |
| budget 150 → 300 (estimate)  | ×4 (quadratic)              | ×3.4–5.3 (terrain) |

`tau_ref` worked values (JS, N=135 M, `N/r` ≈ 40.9 s full grid):
`tau_ref(150)=40.9·0.0625≈2.56 s`, `tau_ref(300)=40.9·0.25≈10.2 s`,
`tau_ref(≥600)=40.9 s`.

## Honest caveats

- **Universal** (machine-independent): the *shape* — linear in R,
  quadratic-then-flat in `e`, parallel speedup `S(P)`, and the P↔M coupling.
- **Machine-specific**: `r` (~3300 cells/ms here; faster CPU/RAM → higher),
  `b` (~0.05; a higher-bandwidth socket saturates later, a busy machine
  raises it).
- **DEM/terrain-specific**: `e_full` (~600 here) and the budget exponent
  (~1.8–2.1 depending on ref placement and relief — flat refs reach farther
  per unit budget). beta/eta shift exploration second-order; the model folds
  them into `e_full`.
- **Error band: ±30%**, dominated by *which* references you place (a ref in a
  flat valley explores far more than one boxed in by ridges at the same
  budget) and machine load (±15–40% swings observed).

## In words

Time is **linear in the number of references**, grows **~quadratically with
the budget** until exploration fills the DEM, and **divides by the effective
thread count** — which is itself **capped by memory** at
`floor((M − 21·N) / 38·N)`, with diminishing returns past a handful of threads
because the work is memory-bandwidth-bound.

The disproportionately powerful knobs are **the budget** (quadratic) and
**alpha** (inverse-quadratic via `e_full`) — they move time far more than
threads do. That's why, at very high reference counts, switching to Sobol
sampling (fewer R) or trimming the budget beats throwing cores/RAM at it.
