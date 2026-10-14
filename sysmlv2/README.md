# Simujaules — SysML v2 model

A SysML v2 model (textual notation) of the whole Simujaules system: the PWA,
its compute engines (JS worker, WebAssembly, native Rust backend, graph
engine), the MCP server and census harness, the optional cloud compute plane,
and the delivery pipeline. It covers requirements, physics, data, interfaces,
structure, behaviour, verification, and deployment context.

This folder is documentation, not code. Nothing here is served:
`deploy.sh` doesn't ship it, and editing it needs no `sw.js` bump.

## Files

| File | Package | What's in it |
|---|---|---|
| `Requirements.sysml` | `SimujaulesRequirements` | 67 requirements: the product requirements (PR) plus every CLAUDE.md invariant, grouped as engine parity (EP), physics (EM), preprocessing (PP), orchestration (CO), KPIs (KP), PWA/release (WEB) and cloud (CL) |
| `Energy.sysml` | `SimujaulesEnergy` | The v2 cost model: `ReadCost` (rider physics → kJ `CostBundle`), `V2Edge`, the descent-clamp proof as a constraint, portal and long-edge costs, `G_SP = 9.7864` |
| `Domain.sysml` | `SimujaulesDomain` | Grid and typed arrays (their precision matters for parity), enums holding the real UI values, run config, fields, routes, the accessibility matrix, bundle contents |
| `Interfaces.sysml` | `SimujaulesInterfaces` | Every boundary: worker message kinds and replies, the wasm C ABI, the backend wire format and `/health`, the orchestrator control plane, MCP tools, external data sources, deploy and DNS APIs |
| `Structure.sysml` | `SimujaulesStructure` | All components, with file paths and key function names. `main.rs` is a part of both the native backend and the wasm module, and `WasmWorker` specialises `JsEngine` |
| `Behavior.sysml` | `SimujaulesBehavior` | DEM load, layer load, engine selection, run dispatch with fallback, the density pool, and release/deploy as actions. Compute, cloud VM and service worker lifecycles as state machines |
| `Verification.sysml` | `SimujaulesVerification` | One verification def per test suite, linked to the requirements it actually asserts (CI vs local-only), plus `ReviewOnly` listing what no test covers |
| `Context.sysml` | `SimujaulesSystemContext` | Actors, use cases, external services (Overpass, R2, GCS, Cloudflare, IBGE, sibling repos), execution platforms, and the root usage `simujaulesContext` with every `satisfy` and `allocate` |

The packages import each other, so open the whole folder rather than single
files. The root element is `SimujaulesSystemContext::simujaulesContext`.

## Validating

```sh
./sysmlv2/validate.sh
```

This parses and validates all `*.sysml` files with the OMG SysML v2 Pilot
Implementation (default 0.62.0, release `2026-08`). It needs no license key.
The script uses a local `java`/`javac` (17 or newer) if present, otherwise
Docker (`eclipse-temurin:21-jdk`). The pilot kernel is downloaded once into
`~/.cache/simujaules-sysml/` and is not vendored here.
`tools/Validate.java` joins the files into one input so cross-file references
resolve, and maps each issue back to `file:line`. The script exits non-zero
on any error. Override the version with `PILOT_RELEASE` / `PILOT_VERSION`.

Current status: **0 errors, 0 warnings**. Every requirement has exactly one
`satisfy` and at least one `verify`.

## Viewing

Any SysML v2 tool that reads textual notation works. Two options:
- **Kotar** (browser IDE): clone `pedalhidro/simujaules`, check out the
  branch carrying this folder, and open `sysmlv2/`.
- The Pilot Implementation's Jupyter kernel (`%viz`, PlantUML + Graphviz).

## Keeping it in sync

The model names real identifiers (functions, message fields, files,
constants, URLs), so it drifts as the code changes. When a change touches
any of these, update the matching package in the same PR:

- **A new or changed invariant in CLAUDE.md** → a requirement in
  `Requirements.sysml`, a `satisfy` in `Context.sysml`, and a `verify` in
  `Verification.sysml`. If no test asserts it, the `verify` goes in
  `ReviewOnly`.
- **A new worker message field or kind** → `Interfaces.sysml`. A new `baseMsg`
  field also has to reach `mcp/lib.mjs` and `census/census-density.mjs`
  (CO-13), so check the model's notes there.
- **A new test suite, or new assertions in one** → `Verification.sysml`.
  Moving a requirement out of `ReviewOnly` is the point.
- **A release** → `ServiceWorker.version` and `precacheUrls` in
  `Structure.sysml`.

Each `doc` comment states facts as of sw.js `v81` (2026-09-25).

## Where the code differs from the other docs

Building the model surfaced a few spots where the code doesn't match the
older docs. The model follows the code:

- `README.md` (repo root) says the in-browser wasm engine was removed. v80
  brought it back as `wasm-worker.js` + `engine32/64.wasm`.
- CLAUDE.md says "there is no CI". In fact `.github/workflows/deploy.yml`
  runs six node suites on PRs and on the `deploy` branch. The backend,
  wasm, MCP, census-density and maxseg suites run locally only.
- CLAUDE.md gives bridge portal cost as `alpha*deckLenM + beta*dh`.
  `buildPortalAdj` actually uses the full `v2Edge(deckLenM, dh)` (aero is
  dropped above the climb threshold, and descents use eps recovery).
- Maximize mode has had no UI control since v36; the engine code path is
  dormant. Halton sampling survives only on bundle import.
- `test-maxseg.mjs` is missing from the CLAUDE.md test list, and no
  requirement covers the max-density segment yet.
