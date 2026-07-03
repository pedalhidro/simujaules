# Round-2 review — Sonnet fix-fleet work order

Generated 2026-07-02 from a 9-dimension, 87-agent adversarially-verified review of
`sampasimu` at v50 (clean tree). **78 findings confirmed, 0 refuted** (4 high, 30
medium, 32 low, 12 info/disclosure). This is the companion to
`docs/review-2026-07-01.md` (round 1, fixed in v49) — round 1 covered the engine
core and the obvious surface; this pass went into rendering/export, bundle
round-trip, data loaders, cloud-ops, i18n completeness, the DP/interp worker
paths, memory at scale, and a fresh-eyes regression hunt on v49 itself, plus a
verified disposition for every item round 1 deliberately left open.

**Every finding below already carries a proposed fix** (`fix.approach` — the exact
functions/values/files to touch), the tests to run, and the invariants not to
break. That fix has ALSO been adversarially vetted (a second agent tried to
refute both the finding and the fix): the `fixSound` field says whether the
proposed approach would work as written; `fixAmendments` (when present) is a
correction to apply on top of it. Treat `fixSound: false` as "the diagnosis is
right, the prescription needs the amendment before you implement it" — not as
license to skip the finding.

## How to run this — execution plan

**Phase 1 (this document, parallel-safe).** 11 lanes below, each with exclusive
file ownership so they can run as concurrent Sonnet agents with NO worktree
isolation needed (they never touch the same file). The six `AJS-*` lanes all
touch `app.js` — **run those six SEQUENTIALLY** (a `pipeline()`, not `parallel()`,
in Workflow-tool terms) since they share one file; the other five lanes
(`LANE-WORKER`, `LANE-GRAPH`, `LANE-BACKEND`, `LANE-CLOUD`, `LANE-DOCS-MISC`) are
each a different file and can run in `parallel()` with each other AND alongside
the whole `AJS` sequence.

**Phase 2 (separate, after Phase 1 lands).** The one `LARGE` item — a physics-model
change (linear aero taper across the climb threshold) that touches the SAME
`energy-worker.js`/`graph-engine.js`/`backend/src/main.rs` files as Phase 1's
`LANE-WORKER`/`LANE-GRAPH`/`LANE-BACKEND`, and also re-depends on the exact edge-cost
formula those lanes' fixes sit next to. Run it alone, sequentially, AFTER Phase 1
is committed — never in parallel with anything else touching those three files.
Full spec at the end of this document; it already has its own verified,
line-level implementation plan across all four cost-function mirrors.

**Phase 3 (centralize, do NOT delegate to the fix agents).** None of the fix specs
below should bump `sw.js` `VERSION` or edit `CHANGELOG.md`/the help-modal
changelog `<details>` individually — every review agent's fix spec initially
included those three files as boilerplate (an artifact of the review prompt, not
a real per-finding need) and it has been stripped from `filesTouched` below for
every finding except the ones genuinely ABOUT `sw.js`/`index.html` content. Bump
the version ONCE, write ONE consolidated changelog entry, after Phase 1 (and,
separately, after Phase 2) lands — exactly the pattern `docs/review-2026-07-01.md`
→ v49 used. Then run the FULL test sweep (`node test-worker-pool.mjs`,
`test-water-raster.mjs`, `test-graph-engine.mjs`, `test-energy-v2.mjs`,
`census/test-census-sampler.mjs`, `census/test-census-density.mjs`,
`cd backend && cargo build --release && node test-backend.mjs`), then an
adversarial re-review of the combined diff (the same pattern used for v49),
before committing.

## Severity legend

`high` = wrong results / data loss / security / money. `medium` = real defect,
user-visible. `low` = minor defect. `info` = disclosure/docs/robustness
improvement, not a bug — several are explicitly `wontfix` with reasoning kept in
`detail`.

## Lane index

| Lane | Scope | Files | Findings |
|---|---|---|---|
| **AJS-1** | app.js pipeline — stage 1: i18n & help modal | `app.js (lines ~1-2000: STRINGS table, help text) + index.html:1489 if the content actually lives there` | 7 |
| **AJS-2** | app.js pipeline — stage 2: DEM/vector/OSM loaders | `app.js (lines ~2000-4000: DEM/FABDEM/GeoPackage/Overpass loaders)` | 13 |
| **AJS-3** | app.js pipeline — stage 3: water mask, network overlay, graph-diff render | `app.js (lines ~4000-4800)` | 7 |
| **AJS-4** | app.js pipeline — stage 4: worker pools, memory, cloud VM client, calibration | `app.js (lines ~4800-8000)` | 12 |
| **AJS-5** | app.js pipeline — stage 5: colormap, GeoTIFF/PNG export | `app.js (lines ~8000-9500)` | 9 |
| **AJS-6** | app.js pipeline — stage 6: bundle export/import | `app.js (lines ~9500-9700)` | 5 |
| **LANE-WORKER** | energy-worker.js + test-worker-pool.mjs | `energy-worker.js, test-worker-pool.mjs` | 6 |
| **LANE-GRAPH** | graph-engine.js + test-graph-engine.mjs | `graph-engine.js, test-graph-engine.mjs` | 5 |
| **LANE-BACKEND** | backend/src/main.rs | `backend/src/main.rs, backend/test-backend.mjs` | 1 |
| **LANE-CLOUD** | Cloud orchestrator + VM scripts | `orchestrator/main.py, orchestrator/deploy-orchestrator.sh, orchestrator/Dockerfile, orchestrator/requirements.txt, vm/startup-script.sh, vm/bake-instance.sh` | 7 |
| **LANE-DOCS-MISC** | sw.js + index.html (structural) + provenance docs | `sw.js, index.html (CSP/focus-trap/changelog-language only), dem/vector/README.md (new)` | 5 |
| **LARGE** (Phase 2) | Linear aero taper — climb-threshold cost discontinuity | energy-worker.js, backend/src/main.rs, graph-engine.js, app.js, + 6 more | 1 |

## AJS-1 — app.js pipeline — stage 1: i18n & help modal

**Files:** `app.js (lines ~1-2000: STRINGS table, help text) + index.html:1489 if the content actually lives there`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [low] Help modal omits major shipped controls: compute-source radio (incl. the publicly reachable Cloud option), graph mode + junction select, compare/scenario picker, and group 0 import/export

**Where:** `app.js:302`  
**Difficulty:** medium  
**Fix touches:** `app.js`, `CLAUDE.md`

**Problem.** The help usage page ends at v42-era features and was never extended for the current control set. (1) Compute source: group '2C. Execução' is a three-way radio Browser/Localhost/Cloud (index.html:1113-1140) with orchestrator URL, 'Cloud password' and 'Manter VM ligada entre cálculos' (keep-warm), and app.js:1948-1949 states 'Cloud now works from ANY origin' — i.e. every visitor of simujaules.pedalhidrografi.co sees it. help.p.backend (app.js:302) documents only the localhost Rust server ('cargo run --release') and never mentions the radio, the Cloud option, the password, keep-warm, or that a VM is booted on the maintainer's account. The stale HTML comment at index.html:1110-1111 still claims Cloud is 'offered only when served locally', and CLAUDE.md still describes a 'Use native backend' checkbox. (2) Graph mode: the 1B toggle 'Calcular sobre o grafo da rede (seguir os vetores)' (net.graph_mode, app.js:164) plus the junction-mode select (net.junctions_crossings/net.junctions_shared) switch the compute to a wholly different engine (graph-engine.js), yet the only help mention is one passing sentence inside help.p.bridges — nothing explains what graph mode computes, that constrain locks on, or the 15 m snap tolerance. (3) Compare: the 'Comparar com cenário sem rede' toggle (net.compare) and the 'Cenário exibido' picker (esrc.constrained/unconstrained/difference, index.html:1983-1989) are documented only in changelog entries; help.p.passes_dual describes the difference-view colour channels assuming the reader already knows the feature. (4) Group '0. Importar / Exportar dados' (config export/import/reset + per-dataset DEM/network/mask/bridges round-trip, index.html:824-857) is absent from the help — step '6 · Salvar / restaurar' covers only the bundle. Failure scenario: a user wanting to reproduce the v48-advertised route comparison, or wondering what 'Cloud (orchestrated VM)' will do (and cost), finds nothing in the in-app documentation.

**Evidence.**
```
app.js:302 help.p.backend pt: 'Servidor local opcional (backend/ no repositório, cargo run --release). … Se inacessível, o app volta silenciosamente para os workers do navegador.' — no Cloud/radio mention; index.html:1110-1111 comment: 'Cloud (local orchestrator boots a VM; offered only when served locally)' vs app.js:1948-1949 'Cloud now works from ANY origin (the orchestrator is a public Cloud Run service…)'; grep of help.* keys mentioning grafo/cenário/cloud matches only help.p.bridges, help.p.passes_dual, help.p.density
```

**Fix approach.** Extend the help usage page (index.html + STRINGS, pt+en): (a) rewrite help.p.backend into a compute-source paragraph covering the Browser/Localhost/Cloud radio — what each does, that Cloud boots an orchestrated VM gated by the shared password, keep-warm semantics, and that top-N/destination-path/graph runs stay in the browser; (b) add help.h.graph/help.p.graph after the network section describing 'seguir os vetores' (compute on the polyline graph, junction modes 'nos cruzamentos' vs 'extremos comuns', constrain forced on, deck flattening, 15 m snap cap); (c) add help.p.compare describing the compare toggle + 'Cenário exibido' picker and route colours (terrain blue / network orange / difference), linking to help.p.passes_dual; (d) add one paragraph under help.h.bundle for group 0 (config JSON export/import/reset and DEM/network/mask/bridges .tif/.gpkg round-trip). Fix the stale comment at index.html:1110-1111, and correct the CLAUDE.md sentence describing the 'Use native backend' checkbox to describe the compute-source radio. Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser: open help in PT and EN; verify each new section renders (data-i18n-html) and describes the visible controls`, `node -e STRINGS parity check for the new keys`

**Invariants — do not break:** New keys need both pt and en; help paragraphs use data-i18n-html on <p> elements like the existing sections; do not change any control behaviour (docs-only) and do not re-gate the Cloud radio; when editing CLAUDE.md change ONLY the stale checkbox sentence, none of the load-bearing engine invariants; bump sw.js VERSION and move the changelog trio together.

*(Fix approach independently re-verified as sound.)*

---

### [low] Help strings contradict shipped v49 behaviour: 'Auto = sqrt-stretched' energy range (renderer is linear p1–p80) and v1-era 'α·dist' in the top-N description

**Where:** `app.js:381`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** Two help-theory strings describe behaviour that no longer exists. (1) help.p.energy_range (app.js:381) tells users 'Faixa da energia: Auto = esticada por raiz quadrada; fixe qualquer limite (min/max) para escala linear com clamping' / 'Auto = sqrt-stretched; pin either bound for a linear scale', but renderFieldToDataURL's own comment at app.js:7004-7007 states the sqrt-stretch branch 'had no caller and was removed' — the value→colour mapping is ALWAYS linear between percentile-clipped bounds (p1/p80 for energy, matching the vmin.label/vmax.label hints). A user pinning a bound expecting to change from sqrt to linear behaviour changes nothing about the scale shape, only the clip. (2) help.p.topn (app.js:508) says the iterative penalty 'multiplica o termo α·dist' — v1-model naming; the v2 engine scales the distance-cost component (a_rol·d + conditional a_aero·d, see energy-worker.js:702-726 'It scales the distance-cost component' and distCost usage at 719/726). The v49 review rewrote the help to the v2 model (finding C2) but these two lines survived. Failure scenario: an EN or PT user reads the help, pins vmin to get 'linear scale' as promised, sees no change in stretch behaviour, and concludes rendering is broken; a user cross-referencing the formula section finds no α·dist term.

**Evidence.**
```
app.js:381 "help.p.energy_range": { pt: "Faixa da energia: Auto = esticada por raiz quadrada; …" }; app.js:7004-7007 comment: 'the value→colour mapping is always linear (lo→hi). The old raw-min/max auto path + sqrt-stretch branch had no caller and was removed'; app.js:508 help.p.topn pt: 'multiplica o termo <code>α·dist</code> em suas células por uma penalidade'
```

**Fix approach.** Rewrite help.p.energy_range (pt+en) to: Auto = clip percentil p1–p80 com mapeamento linear; fixar min/max substitui o limite automático (clamping) — no sqrt claim. Rewrite the α·dist phrase in help.p.topn (pt+en) to name the v2 distance-cost term, e.g. 'multiplica o componente de custo por distância (a_rol·d + a_aero·d) das células reusadas', consistent with the help.p.cost formula section. Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser: open help in PT and EN, verify the rewritten paragraphs; pin vmin/vmax and confirm the described clamping behaviour matches`, `node test-worker-pool.mjs (sanity)`

**Invariants — do not break:** Do not change the renderer or the worker penalty code to match the old text — the code is the source of truth (style knobs must never trigger a recompute); keep pt/en in lockstep; keep the terminology consistent with help.p.cost/help.formula (a_rol, a_aero, β).

*(Fix approach independently re-verified as sound.)*

---

### [low] Help modal 'Como usar' documents the 'Maximizar energia' control removed from the UI in v37

**Where:** `index.html:1489`  
**Difficulty:** small  
**Fix touches:** `index.html`, `app.js`, `sw.js`, `CHANGELOG.md`

**Problem.** The help modal's step-by-step usage walk-through contains a full section 'Maximizar energia' (index.html:1489-1490, rendering STRINGS help.h.maximize at app.js:489 and help.p.maximize at app.js:307) that describes a toggle and an L-length input ('0: Dijkstra invertido… L>0: DP em camadas…'), but the #maximize checkbox and #maximize-length input were removed from the UI in v37 (CHANGELOG.md v37: '"maximizar energia" … were removed'; app.js:1168-1174 documents the control as dormant — getElementById("maximize") is null). Two more help strings also reference the mode as if togglable: help.p.backend (app.js:302) says maximize 'continua no navegador', and help.p.cost_extra (app.js:500) says 'Com maximizar ligado o orçamento de energia não se aplica'. Failure scenario: a user reads the help between step '3 · Parâmetros' and '4 · Computar', then searches the parameter panel for a maximize toggle that does not exist anywhere in the UI.

**Evidence.**
```
index.html:1489 <h4 data-i18n="help.h.maximize">Maximizar energia</h4> / 1490 <p data-i18n-html="help.p.maximize"></p>; app.js has no element and index.html no control with id="maximize" (grep 'id="maximize' returns nothing); app.js:1169-1171 comment: '#maximize has had no UI control since v36 … this stays dormant (maxCheck null, guarded below)'
```

**Fix approach.** Remove the two help lines (index.html:1489-1490) from the usage page, or move the content to the theory page reframed as 'modo interno/dormante (sem controle na interface)'. Trim the 'e "maximizar"' clause from help.p.backend (app.js:302 pt+en) and the final sentence 'Com maximizar ligado…'/'With maximize on…' from help.p.cost_extra (app.js:500 pt+en), or reword both to say the mode currently has no UI control. Do NOT delete the dormant guard code at app.js:1172-1191 or the param.budget.maximize_title key (they are deliberate forward-compatibility, per docs/review-2026-07-01.md). Optionally delete the now-orphaned help.h.maximize/help.p.maximize keys. Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser: open the help modal in PT and EN, confirm the usage walk-through no longer references a maximize control`, `node test-worker-pool.mjs (sanity)`

**Invariants — do not break:** Keep engine/backend maximize support and the dormant #maximize guard intact (engine + Rust still implement the mode); edit both pt and en of every touched key; bump sw.js VERSION and move the changelog trio together.

*(Fix approach independently re-verified as sound.)*

---

### [low] Language toggle misses imperatively-set t() strings: open layer-control panel rows, the graph-mode constrain tooltip, and the pending-style dirty marker

**Where:** `app.js:1590`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** setLang() re-applies [data-i18n*] attributes and re-renders the dynamic metas, but three imperative sites are missed. (1) The on-map layer-control panel rows (buildLayerRow, app.js:1590/1610/1620/1627/1637) set row labels, checkbox/slider aria-labels and the GPX upload tooltip via t() only when the panel is (re)opened (comment at app.js:1549-1551: 'Rebuilt on every open'); the panel is a non-blocking corner panel that commonly stays open (it hosts the 3B–3D styling controls), so clicking the PT/EN pill leaves every layer name and aria-label in the previous language until the panel is closed and reopened. (2) syncGraphModeUI() at app.js:4496 sets row.title = t("net.graph_constrain_locked") directly instead of via the dataset.i18nTitle pattern the codebase itself established for #e-max (app.js:1184-1185), so with graph mode on, toggling language leaves the constrain-checkbox tooltip in the old language until graph mode is toggled. (3) markStyleDirty() (app.js:1027) renders the pending-style cue as t("btn.refresh_style") + " ●" on a button that also carries data-i18n="btn.refresh_style"; applyTranslations() (app.js:545-547) overwrites textContent with the bare label, silently erasing the ● although btn.dataset.dirty stays "1" — the user loses the only visual cue that style changes are pending. Failure scenario: user opens the layer panel, enables graph mode, edits a colormap (● appears), then clicks the language pill: panel rows and the constrain tooltip stay in the old language and the pending-style dot vanishes.

**Evidence.**
```
app.js:1590 b.setAttribute("aria-label", t(delta > 0 ? "order.move_up" : "order.move_down") + " — " + t(labelKey)); app.js:4496 row.title = graph ? t("net.graph_constrain_locked") : ""; app.js:1027 btn.textContent = `${t("btn.refresh_style")} ●`; app.js:545-547 applyTranslations sets el.textContent = t(el.dataset.i18n) for every [data-i18n]; setLang (app.js:567-584) re-renders metas but never renderOrderList()/syncGraphModeUI()/the dirty marker
```

**Fix approach.** (1) Expose the layer panel refresh: in the DOMContentLoaded closure, assign the existing renderOrderList to a module-scope hook (e.g. let refreshLayerOrderList = null; refreshLayerOrderList = renderOrderList;) and in setLang() call it when the panel is active: if (refreshLayerOrderList && document.getElementById("layer-order-modal")?.classList.contains("active")) refreshLayerOrderList(). (2) In syncGraphModeUI() switch to the established pattern: set row.dataset.i18nTitle = "net.graph_constrain_locked" (and delete it when leaving graph mode) plus row.title = t(...) — applyTranslations then keeps it current. (3) In applyTranslations(), after setting textContent, special-case the refresh-style button: if (el.id === "refresh-style" && el.dataset.dirty === "1") el.textContent += " ●" (or have applyTranslations call clear/markStyleDirty's renderer). Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser: open the layer panel, enable graph mode, dirty the style (change colormap), toggle PT↔EN; verify rows/tooltip/● all follow the language and the ● survives`, `node test-worker-pool.mjs (sanity)`

**Invariants — do not break:** renderOrderList must keep proxying the hidden #layer-inputs-store inputs (do not duplicate listeners on re-render — it rebuilds innerHTML, which is safe); do not make style re-rendering fire on language toggle (style knobs must never trigger a recompute; the ● is display-only); keep the dataset.i18nTitle convention consistent with app.js:1184; bump sw.js VERSION.

*(Fix approach independently re-verified as sound.)*

---

### [info] 30 dead STRINGS keys from pre-v37/v43 UI iterations linger in the table, several shadowing current controls

**Where:** `app.js:22`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** A scripted cross-reference of all 464 STRINGS keys against every literal and template-built usage (t(), data-i18n*, setAttribute, the order.${key} builder, wrapper functions like setCloudHint/fail) finds 30 keys defined but unreachable: net.render, net.render_opacity, imp.clear, imp.show, imp.opacity, aria.opacity_impassable, draw.erase, draw.erase_imp, bridge.show, bridge.opacity, aria.opacity_bridge, param.use_backend, cloud.local_only, param.maximize, param.max_length, param.ref_source, ref.click, ref.random, sampling.random, sampling.halton, aria.opacity_tiles, aria.opacity_relief, aria.opacity_energy, aria.opacity_passes, layer.relief, layer.energy, layer.passes, order.open, passes.chan_net, passes.chan_terrain. They are leftovers of the v37 layer-panel consolidation (imp.*/bridge.*/net.render*/aria.opacity_*/layer.relief|energy|passes superseded by the order.* rows), the removed 'origem das referências' dropdown (param.ref_source/ref.click/ref.random), renamed sampling options (sampling.random/halton vs the shipped sampling.uniform/sobol/census), the retired 'Use native backend' checkbox (param.use_backend, cloud.local_only), and the dormant maximize toggle (param.maximize, param.max_length). Risk is maintenance-only: a future fixer may 'reuse' a dead key believing it is wired, or translate stale copy. Note the near-misses that ARE used and must NOT be deleted: order.relief/impassable/energy/network/passes/refgeom/routes (built dynamically as order.${key} at app.js:1651), param.budget.maximize_title (dormant guard at app.js:1184), draw.barrier_added/draw.corridor_added (ternary inside t()), and the cloud.* lifecycle keys (via setCloudHint).

**Evidence.**
```
Scripted check (STRINGS extraction + repo-wide literal/template scan) reports exactly these 30 keys with zero references; e.g. app.js:305 "param.maximize": { pt: "Maximizar energia (inverter otimização)", … } has no matching control (no id="maximize" in index.html); app.js:445-446 passes.chan_net/passes.chan_terrain match no call site or attribute
```

**Fix approach.** Delete the 30 listed key lines from the STRINGS table in app.js, EXCEPT keep param.maximize and param.max_length if the maintainer wants them for the documented dormant-maximize restoration (in that case add a one-line comment '// dormant: no UI control since v37' above them, mirroring app.js:1168-1171). Do not touch order.* (relief/impassable/energy/network/passes/refgeom/routes), param.budget.maximize_title, draw.barrier_added/corridor_added, or any cloud.* key other than cloud.local_only. Re-run the parity scan after deletion to confirm no t()/data-i18n reference breaks (t() falls back to showing the raw key if one slips through).

**Tests to run:** `node -e scan: extract STRINGS, grep app.js+index.html for each remaining key and for the deleted ones (deleted keys must have zero references)`, `Manual browser: full UI click-through in PT and EN watching for raw key names leaking into the UI`

**Invariants — do not break:** t(key) returns the raw key for unknown keys — any missed live reference becomes user-visible, so the post-deletion scan is mandatory; keep pt/en pairs intact for all surviving keys; this is a served-file change: bump sw.js VERSION with a changelog-trio line.

*(Fix approach independently re-verified as sound.)*

---

### [info] Budgeted density's saturation and border biases, and exact-tie corridor placement, remain undisclosed in the help modal and README

**Where:** `app.js:510`  
**Difficulty:** small  
**Fix touches:** `app.js`, `README.md`

**Problem.** Two acknowledged methodology artifacts (I1/I2 from the 2026-07-01 review) still have no user-facing disclosure at v49: (1) with an energy budget (eMax), each reference's shortest-path tree is truncated at the budget frontier (energy-worker.js:278-281 — out-of-budget cells stay E=Infinity), so passes counts near the frontier are systematically depressed and cells near the DEM border have clipped catchments — corridors read as weaker there for purely geometric reasons; when the budget saturates the whole DEM the density flattens toward uniform. (2) On EXACT f64 cost ties the corridor a trajectory takes depends on heap pop order — an implementation artifact: densityField's radix heap matches the Rust backend but may pick different (equally optimal) parents than the binary-heap single-point modes (documented for developers in CLAUDE.md, invisible to users). help.p.passes (app.js:506), help.p.density (app.js:510), help.p.budget_mode (app.js:273) and README.md's density section describe none of this, so users doing quantitative corridor comparisons near budget frontiers/borders, or across engines on flat terrain, over-read artifacts as topography.

**Evidence.**
```
"help.p.density": { pt: "Para K pontos de referência: ... soma; depois divide por H·W de novo. ...", en: 'For K reference points: ... The energy layer in this mode is the per-cell mean across the references that can reach it.' }  // no saturation/border/tie caveat anywhere
```

**Fix approach.** Disclosure-only, three edits in the STRINGS table plus README: (1) append to help.p.budget_mode (app.js:273): a sentence that near the budget frontier subtrees are truncated so passes are systematically lower there, and cells whose catchment is clipped by the DEM border are likewise biased — compare corridors only well inside the budget and away from borders (PT + EN). (2) append to help.p.density (app.js:510): the same frontier/border caveat plus: when the budget (or the DEM edge) truncates most references equally, density saturates and differences flatten. (3) append to help.p.passes (app.js:506): on exactly-tied optimal costs the corridor placement is a tie-breaking artifact of the search order (density and the native backend break ties identically; the single-point modes may differ) — flat, symmetric terrain can shift corridors between runs/engines without meaning. (4) Add a matching short paragraph to README.md's density/passes description (the section fixed by C4, which already warns about K-scaling). No code changes. Bump sw.js VERSION + changelog trio (help modal text is user-visible).

**Tests to run:** `Browser: open the help modal in PT and EN, confirm the three paragraphs render (no broken HTML in the STRINGS values — they are innerHTML)`, `node test-worker-pool.mjs (sanity, no engine change)`

**Invariants — do not break:** STRINGS entries need BOTH pt and en; the strings are injected as HTML — escape any <, > in the added text or use <code> deliberately; no engine/behaviour change whatsoever (style-knob rule: doc text must not touch compute paths); VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [info] app.js cloud comments describe an orchestrator lease/hard-cap that no longer exists — the keepalive is a no-op and the real backstops are in-VM only

**Where:** `app.js:1990`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** Several load-bearing comments still describe the OLD local-orchestrator lease model: cancelActiveCompute (app.js 1990-1991: 'the orchestrator's own lease deadline (or the next run's stop) reaps the VM'), beaconStopCloudVm (2030: 'the orchestrator lease + hard-cap + in-VM idle-watchdog are the backstops'), computeDone (5703-5705: 'orchestrator lease + in-VM idle-watchdog'), startCloudKeepalive (7958-7959: 'extend the VM lease so the orchestrator doesn't reap it mid-run'), and refreshBackendCores carries two contradictory paragraphs (7806-7813: first claims 'the orchestrator proxies the VM's /health', then the correction says it has no /health). In reality /cloud/keepalive is a documented no-op (orchestrator/main.py 635-640) and the keepalive's ONLY remaining function is client-side: keepaliveTimer serves as the 'compute in flight' flag for beaconStopCloudVm. Risk: a future maintainer reads 'the lease reaps it', removes the keepalive as dead network traffic, and silently breaks the mid-compute stop protection; or trusts a non-existent orchestrator-side hard cap when reasoning about cost (e.g. the cancel-path deliberately leaves the VM to a 'lease deadline' that will never come — only the 15-min in-VM watchdog does).

**Evidence.**
```
app.js:1990-1991 `// A superseded cloud run must stop extending the VM lease; the orchestrator's\n  // own lease deadline (or the next run's stop) reaps the VM.` vs main.py:637 `"""No-op (compat). O custo é contido pelo idle-watchdog DA VM, não por lease."""`.
```

**Fix approach.** Comment-only rewrite in app.js: at 1990-1991, 2028-2030, 5702-5706, 7958-7959 and the stale first paragraph of refreshBackendCores (7806-7810), replace 'orchestrator lease/hard-cap' wording with the actual model: '/cloud/keepalive is a no-op on the orchestrator; keepaliveTimer is kept purely as the local compute-in-flight flag (beaconStopCloudVm), and the cost backstops are the in-VM idle-watchdog (~15 min) + uptime cap'. Do NOT remove the keepalive timer itself (it is the in-flight flag, and finding #6's lease fix re-purposes the traffic). No behaviour change.

**Tests to run:** `Load app.js in a browser (syntax check)`

**Invariants — do not break:** Comments only — zero behaviour change. Historical changelog entries (index.html v27, CHANGELOG.md) stay as written (they describe the past). If deployed, app.js changed → sw.js VERSION bump per discipline (fold into the next release rather than shipping alone).

*(Fix approach independently re-verified as sound.)*

---

## AJS-2 — app.js pipeline — stage 2: DEM/vector/OSM loaders

**Files:** `app.js (lines ~2000-4000: DEM/FABDEM/GeoPackage/Overpass loaders)`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [high] Async input loaders have no DEM-identity guard: a DEM swap mid-load installs stale-extent or wrong-sized data onto the new grid

**Where:** `app.js:3214`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** All four slow async input loaders in app.js — loadVectorNetwork (.gpkg, line 2994), loadOsmNetwork (streets, 3304), loadOsmBridges (3383), loadOsmWater (4102) — read state.dem, await network/file I/O for seconds-to-minutes, then mutate global state without checking whether state.dem is still the same DEM. loadDemFromArrayBuffer (2409) deliberately clears the network/mask/bridges on every DEM load precisely because they are sized to the old grid, but an in-flight loader re-installs them afterwards. Worst case is loadVectorNetwork: it destructures {H, W, dx, dy, originX, originY} from state.dem once at line 3063, allocates networkMask = new Uint8Array(W*H) with the OLD dims, and yields to the event loop every 2000 features (line 3193, `await new Promise((r) => setTimeout(r, 0))`) — during a 30-60 s rasterise of the 145 MB sampa-viario.gpkg the user can load a different DEM (loadDemFromArrayBuffer runs, calls clearVectorNetwork), and when the .gpkg loop finishes it sets state.networkMask (sized to the old H×W) at line 3214 against the new DEM. Downstream, the compute-grid AND (network constraint) and recomputeCorridors index that mask with the NEW W/H row-major indices, scrambling rows / reading undefined — silently wrong constrained energy fields. The three Overpass pulls are the milder variant: their bbox was clamped to the OLD DEM extent, but they install onto the new DEM (loadOsmWater caches state.osmWaterGeom at 4154 and calls rebuildOsmWaterMask; loadOsmNetwork calls installNetworkFromLines at 3360; loadOsmBridges calls installBridgesFromWays at 3456), producing a partial/empty water mask or network covering the wrong extent, with a success status. Note the compute-side generation guard (state.computeGen / cancelActiveCompute) does NOT cover this: it protects compute results, not input installs.

**Evidence.**
```
loadVectorNetwork line 3063: `const { originX, originY, H, W, dx, dy } = state.dem;` … line 3117: `const networkMask = new Uint8Array(W * H);` … line 3193: `await new Promise((r) => setTimeout(r, 0));` … line 3214: `state.networkMask = networkMask;` — no re-check of state.dem after any await. loadDemFromArrayBuffer comment at 2537-2539: "Drop any previously loaded vector network — its rasterised mask is sized to the *previous* DEM's H×W and would corrupt the next compute (or crash) if reused."
```

**Fix approach.** In each of loadVectorNetwork, loadOsmNetwork, loadOsmBridges and loadOsmWater, capture `const demRef = state.dem;` immediately after the existing `if (!state.dem)` guard (state.dem is replaced wholesale by loadDemFromArrayBuffer, so object identity is a correct epoch token). Then bail out with `if (state.dem !== demRef) { status.textContent = t("status.load_superseded"); return; }` at every point that follows an await and precedes a state mutation: (a) inside loadVectorNetwork's per-2000-feature yield loop (right after the `await new Promise` at ~3193) and once more before the install tail at ~3199 (before `state.networkMask = networkMask`); (b) in loadOsmNetwork before `state.networkBridgeCandidates = …` / `installNetworkFromLines(...)` (~3355-3360); (c) in loadOsmBridges before `installBridgesFromWays(ways, "OSM")` (~3456); (d) in loadOsmWater before `state.osmWaterGeom = { bodies, rivers, coastlines }` (~4154). Add a new STRINGS entry `"status.load_superseded": { pt: "Carregamento cancelado — o DEM mudou durante a operação.", en: "Load cancelled — the DEM changed during the operation." }` near the other status.* keys (~line 60).

**Tests to run:** `node test-worker-pool.mjs`, `node test-water-raster.mjs`, `Manual browser: load Sampa Centro DEM, click 'Viário RMSampa' (145 MB .gpkg), while it rasterises load the Água Preta example DEM, verify the network install is abandoned with the superseded message and state.networkMask stays null / matches the new DEM`

**Invariants — do not break:** New user-facing text MUST go through the STRINGS table (pt + en), never hardcoded. Do not remove the existing cancelActiveCompute() calls in the install tails. Do not change the engine dispatch, computeGen logic, or the mirrored helpers (fillRingsEvenOdd etc. are hand-synced with test-water-raster.mjs — leave them untouched). If this ships, bump sw.js VERSION and update the changelog trio (CHANGELOG.md, index.html help-modal <details id="changelog">, sw.js version-history comment) in the same commit.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Hiding the tab while the cloud VM is booting stops the VM mid-boot and dooms the run: the 'compute in flight' guard (keepaliveTimer) only starts after boot completes

**Where:** `app.js:2032`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** beaconStopCloudVm() (app.js 2031-2036) treats `state.cloud.keepaliveTimer` as the 'a run is in flight' signal and otherwise POSTs /cloud/stop when the tab is hidden (visibilitychange handler, keep-warm unchecked — the default). But startCloudKeepalive() is only called AFTER ensureCloudVm resolves ready (line 6593), while `state.cloud.mode = "cloud"` and `state.cloud.orchestratorUrl` are set BEFORE the boot wait (lines 6570-6571). The boot takes ~1-8 minutes (warm start ≈60 s, from-scratch create ≈4-8 min), during which users routinely switch tabs. Concrete failure: user clicks Run in Cloud mode → VM booting → user switches to another tab to wait → visibilitychange fires with keepaliveTimer null → stopCloudVm posts /cloud/stop → the orchestrator stops the VM under the still-polling ensureCloudVm, which sees STOPPING/STOPPED (not ERROR) and keeps polling until the deadline → boot_failed → the run silently falls back to the slow/OOM-prone browser pool. `state.computeStartedAt` is already nonzero throughout the boot (set at line 5647, before the cloud dispatch), so a correct guard exists.

**Evidence.**
```
app.js:2031-2036 `function beaconStopCloudVm() {\n  if (state.cloud.keepaliveTimer) return; // a compute is running — leave the VM alone\n  if (state.cloud.mode === "cloud" && state.cloud.orchestratorUrl) {\n    stopCloudVm(state.cloud.orchestratorUrl, { beacon: true });` ; keepalive only armed at :6593 `startCloudKeepalive(backendUrl);` after `ready = await ensureCloudVm(...)`.
```

**Fix approach.** In the `visibilitychange` listener (app.js ~2037-2046), add a compute-in-flight check so a hidden tab never stops the VM while a run (including its boot phase) is active: `if (document.visibilityState === "hidden" && !state.computeStartedAt && !document.getElementById("cloud-keep-warm")?.checked) { beaconStopCloudVm(); }`. Leave the `pagehide` listener unchanged (a real unload mid-boot SHOULD stop the VM; mid-compute unload is already covered by the keepaliveTimer guard inside beaconStopCloudVm, with the in-VM watchdog as backstop). Alternatively put `if (state.computeStartedAt) return;` at the top of beaconStopCloudVm — but note that also changes pagehide-mid-boot behaviour (VM then relies on the 15-min idle watchdog); the visibilitychange-only guard is the precise fix.

**Tests to run:** `Browser: start a Cloud run against DRY_RUN orchestrator, switch tabs during the boot poll, verify no POST /cloud/stop is issued and the run proceeds; then verify tab-hide with NO run in flight still stops an idle warm VM`, `node test-worker-pool.mjs (regression)`

**Invariants — do not break:** Preserve the existing semantics: keep-warm checked → tab-hide never stops the VM; a VM mid-compute is never stopped by visibility changes; pagehide remains the real-unload stop path. sw.js VERSION bump + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Multi-band GeoTIFFs are read band-interleaved and treated as single-band — silent garbage DEM/mask

**Where:** `app.js:2432`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** loadDemFromArrayBuffer reads `image.readRasters({ interleave: true })` without a `samples` restriction. In geotiff.js 3.x (index.html pins geotiff@3.0.5) this returns ALL bands pixel-interleaved: for a k-band image the result has length H*W*k laid out [b0,b1,…bk-1, b0,b1,…]. The loader then indexes it as a single-band H*W array (mask loop at 2439, height passed to the worker), so for any multi-band GeoTIFF — RGB-rendered terrain, elevation+mask 2-band exports, elevation+slope stacks — the 'DEM' becomes the first H*W interleaved samples: the top 1/k of the image's bands smeared across the whole grid. There is no error and no warning; the DEM rectangle, relief and computes all proceed on garbage heights. The same unrestricted read exists in readMaskGeoTIFF (line 8708), so a multi-band impassable-mask GeoTIFF is similarly misread.

**Evidence.**
```
app.js:2432: `const raster = await image.readRasters({ interleave: true });` then 2433: `const height = raster instanceof Float32Array ? raster : Float32Array.from(raster);` and 2439: `for (let i = 0; i < H * W; i++) { const v = height[i]; …`. app.js:8708 (readMaskGeoTIFF): `const data = await image.readRasters({ interleave: true });`.
```

**Fix approach.** Select band 0 explicitly: change both reads to `readRasters({ samples: [0], interleave: true })` — in loadDemFromArrayBuffer (line 2432) and readMaskGeoTIFF (line 8708). Optionally also in the FABDEM tile read at line 2348 for consistency (FABDEM tiles are single-band, so it is a no-op there). With samples:[0] geotiff.js returns a flat H*W array of the first band, which is the elevation band in every common DEM layout.

**Tests to run:** `node test-worker-pool.mjs`, `Manual browser: load a known single-band example DEM (Água Preta) and verify identical demMeta/relief as before the change; then load a 2-band GeoTIFF (gdal_merge or gdal_translate -b 1 -b 1) and verify the terrain now matches band 1`

**Invariants — do not break:** Must not change behaviour for single-band DEMs (all shipped examples and FABDEM tiles are single-band — outputs must stay byte-identical, including the exported dem.tif round-trip). No worker/Rust changes. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [medium] GDAL_NODATA is compared without float32 rounding — nodata cells enter the DEM mask as valid elevations

**Where:** `app.js:2437`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** loadDemFromArrayBuffer stores elevations as Float32Array (line 2433 converts non-f32 rasters with Float32Array.from), but the nodata sentinel is `parseFloat(nodataRaw)` — a float64 — and the mask test at line 2441 is `v !== nodata` where v is the f32-widened f64 read back from the Float32Array. Whenever the GDAL_NODATA string does not parse to EXACTLY the f32-widened value, every nodata cell passes the mask test and becomes a 'valid' elevation. Two realistic triggers: (a) a Float64 source raster whose nodata is not f32-representable (e.g. -99999.99): Float32Array.from rounds the stored values but parseFloat keeps full precision → mismatch → nodata cells become land at ~-100000 m, creating colossal cliffs that corrupt every energy field along the DEM's nodata border; (b) a Float32 raster whose GDAL_NODATA was written with truncated precision (e.g. "-3.4e+38" or "3.402823466e+38" instead of the 17-digit round-trip form): the parsed f64 ≠ the stored f32 value → the float-max sentinel becomes a 3.4e38 m elevation. The same unrounded comparison exists in the FABDEM mosaic per-tile nodata handling at lines 2329-2330/2366 (benign today because FABDEM uses -9999, but the same one-line hardening applies).

**Evidence.**
```
app.js:2436-2441: `const nodataRaw = fileDirectory.getValue("GDAL_NODATA"); const nodata = nodataRaw ? parseFloat(nodataRaw) : null; … mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;` where `height` is `raster instanceof Float32Array ? raster : Float32Array.from(raster)` (2433).
```

**Fix approach.** Round the sentinel through float32 so both sides of the comparison have gone through the same f32 conversion: in loadDemFromArrayBuffer line 2437 change to `const nodata = nodataRaw ? Math.fround(parseFloat(nodataRaw)) : null;`. Apply the identical change to the FABDEM per-tile sentinel in loadFabdemForView (line ~2330: `const nodata = nodataRaw ? Math.fround(parseFloat(nodataRaw)) : null;`). This is exact: v = height[i] is always the f64 widening of an f32, and Math.fround(parseFloat(s)) is the f64 widening of the f32 nearest the written sentinel, so equality holds iff the cell held the sentinel.

**Tests to run:** `node test-worker-pool.mjs`, `Manual browser: build a small Float64 GeoTIFF with GDAL_NODATA=-99999.99 (gdal_translate -ot Float64 -a_nodata -99999.99), load it, and verify demMeta/mask exclude the nodata region (previously it rendered as a deep pit)`

**Invariants — do not break:** Do not change the mask semantics for finite valid cells (Number.isFinite guard stays). The FABDEM mosaic must keep NaN as its internal gap sentinel. No engine/worker changes — this is loader-only, no Rust parity impact. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [medium] exportDemTif drops the source GDAL_NODATA tag — re-importing an exported DEM turns nodata cells into valid terrain

**Where:** `app.js:2776`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** loadDemFromArrayBuffer() parses the source DEM's GDAL_NODATA (app.js:2436-2437) and uses it only to build the mask — the nodata value itself is not stored on state.dem, and state.dem.height keeps the raw sentinel values (e.g. -9999) in nodata cells. exportDemTif() then writes state.dem.height through tiffMetadataForDem(), which never emits a GDAL_NODATA tag. Consequences: (a) the export/import round trip the UI advertises ('import accepts exactly what export produces', wireImport at app.js:1504-1514) is lossy — re-importing dem.tif finds no GDAL_NODATA, so mask = isFinite only, and every former nodata cell becomes VALID terrain at elevation -9999 m; energy computes then route around/through phantom -9999 m canyons along the old nodata border, producing wrong energy fields; (b) in QGIS the exported dem.tif's statistics/stretch include the -9999s. Verified that geotiff.js 3.0.5 writes a GDAL_NODATA ASCII tag correctly (read back as '-9999\0'; the app's own parseFloat(nodataRaw) parses it, and GDAL reports 'NoData Value=-9999' with clean stats). Failure scenario: user loads a DEM whose nodata is -9999 (common for float DEMs), clicks export DEM (group 0), later re-imports that dem.tif — the nodata ring becomes a -9999 m pit and the energy field is corrupted around it.

**Evidence.**
```
app.js:2436-2442 (nodata parsed, then discarded):
  const nodataRaw = fileDirectory.getValue("GDAL_NODATA");
  const nodata = nodataRaw ? parseFloat(nodataRaw) : null;
  ... mask[i] = (Number.isFinite(v) && (nodata === null || v !== nodata)) ? 1 : 0;
state.dem (2479-2488) has no nodata field. app.js:2776:
  ioDownload(new Uint8Array(writeRasterAsGeoTIFF(state.dem.height, state.dem, "float32")), "dem.tif", ...)
and tiffMetadataForDem never sets GDAL_NODATA.
```

**Fix approach.** 1) In loadDemFromArrayBuffer(), persist the parsed value: add `nodata,` to the state.dem object literal (app.js:2479-2488). 2) Extend writeRasterAsGeoTIFF(values, dem, sampleKind) with an optional 4th param `extraMd` merged into the metadata (Object.assign(md, extraMd) after tiffMetadataForDem), and in exportDemTif() call `writeRasterAsGeoTIFF(state.dem.height, state.dem, "float32", state.dem.nodata != null ? { GDAL_NODATA: String(state.dem.nodata) } : undefined)`. Do NOT put GDAL_NODATA into tiffMetadataForDem unconditionally — energy/passes/network/impassable tifs must not inherit the DEM's elevation sentinel. Note geotiff.js appends a NUL terminator to the ASCII tag; the app's own re-import (parseFloat) and GDAL both handle it. Bump sw.js VERSION + changelog trio.

**Tests to run:** `Browser round trip: load a DEM with GDAL_NODATA=-9999, export DEM (group 0), re-import the produced dem.tif, and confirm the mask (nodata cells) is identical to the first load`, `gdalinfo -stats on the exported dem.tif: 'NoData Value=-9999' and statistics exclude the sentinel`, `node test-worker-pool.mjs (guard)`

**Invariants — do not break:** energy.tif/passes.tif/network.tif/impassable.tif metadata must be unchanged by this fix (no inherited GDAL_NODATA); bundle reload (readRasterFromGeoTIFF) behaviour unchanged; state.dem shape additions must not break buildMetadata/bundle export; sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [low] Concurrent DEM loads race: FABDEM/example/file loaders have no generation guard and the FABDEM button is never disabled

**Where:** `app.js:2220`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** Unlike the three Overpass pulls (which disable their buttons while in flight), the DEM initiators — loadFabdemForView (2220), loadDemFromUrl (2109), the #dem-file change handler (2085) and the Group-0 import-dem handler (1514) — neither disable their triggers nor carry a generation token. Two consequences: (a) last-FINISHER wins: click 'Carregar FABDEM' (multi-second tile mosaic), then click a hosted example DEM — the example loads and displays, and seconds later the FABDEM mosaic completes and silently replaces it; double-clicking the FABDEM button runs two full mosaics concurrently, interleaving progress-bar and status writes. (b) provenance desync: loadDemFromUrl sets `state.demSourceUrl = url` BEFORE `await loadDemFromArrayBuffer(buf, label)` (2115-2116), so with two interleaved loads state.dem can hold load A's raster while state.demSourceUrl holds load B's URL — the exported bundle metadata (app.js:9295 `sourceUrl: state.demSourceUrl || null`) then records the wrong DEM source, breaking bundle reproducibility.

**Evidence.**
```
app.js:1380-1384: fabBtn click handler calls loadFabdemForView() with no disabled toggle (contrast loadOsmBridges 3403-3404 `btn.disabled = true`). app.js:2115-2116: `state.demSourceUrl = url; await loadDemFromArrayBuffer(buf, label);`.
```

**Fix approach.** Add a `demLoadGen: 0` field to the state initializer (~line 1880). In each DEM initiator (demFile change handler at 2085, loadDemFromUrl at 2109, loadFabdemForView at 2220, the import-dem wireImport lambda at 1514) capture `const gen = ++state.demLoadGen;` as the first statement, and immediately before the `state.demSourceUrl = …` assignment + `await loadDemFromArrayBuffer(...)` call add `if (gen !== state.demLoadGen) return;` (last-CLICK wins). Additionally disable the FABDEM button for the duration: in loadFabdemForView set `const fb = document.getElementById("ex-fabdem-view"); if (fb) fb.disabled = true;` before the try and re-enable it in the existing finally, mirroring the loadOsmBridges pattern.

**Tests to run:** `Manual browser: click FABDEM load then immediately an example DEM — verify the example DEM stays loaded and demMeta/status never revert; verify bundle metadata sourceUrl matches the displayed DEM`

**Invariants — do not break:** loadDemFromArrayBuffer must still run cancelActiveCompute() first and remain callable from applyMetadataToUI/bundle paths without a gen token. Don't disable the file input elements (only buttons). Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [low] loadVectorNetwork failures before its try block leave the global progress bar permanently active

**Where:** `app.js:3008`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** loadVectorNetwork activates the shared progress bar (`progress.classList.add("active")`, line 3008) and then performs three fallible awaits BEFORE entering the try/finally that removes it (try starts at 3021, finally at 3230): readFileWithProgress (FileReader error), getSQL() (rejects when the sql.js CDN is blocked/offline — its comment at 2676 says exactly this), and `new SQL.Database(...)`. If any of these throws, the error propagates to the caller — and two of the three callers do not clean up: loadVectorFromUrl's catch (2132-2135, the 'Viário RMSampa' example button) and the Group-0 wireImport catch (1511) only set status, so the indeterminate progress bar stays active on screen indefinitely (the direct #vector-file handler at 1400 does remove it). The user sees a stuck loading bar over the map until they start some other operation.

**Evidence.**
```
app.js:3008-3021: `progress.classList.add("active"); … const buf = await readFileWithProgress(file, …); … const SQL = await getSQL(); const db = new SQL.Database(new Uint8Array(buf)); … try {` — the finally that does `progress.classList.remove("active")` is at 3230-3233, inside a try that starts after those awaits. wireImport catch at 1511: `catch (err) { console.error(err); status.innerHTML = …; }` — no progress cleanup.
```

**Fix approach.** Restructure loadVectorNetwork so the finally covers the whole body: declare `let db = null;` before `progress.classList.add("active")`, move the file-read/getSQL/`db = new SQL.Database(...)` statements inside the existing try, and change the finally to `finally { if (db) db.close(); progress.classList.remove("active"); }`. No caller changes needed (their catches keep handling the status line).

**Tests to run:** `Manual browser: block cdnjs.cloudflare.com in devtools network conditions, click 'Viário RMSampa', verify the failure status shows AND the progress bar deactivates; then load a valid .gpkg normally to confirm the happy path still completes`

**Invariants — do not break:** db.close() must still run exactly once and only when the Database was constructed. Keep the progress-fraction milestones (0-40 file read, 40-50 sql init, 50-100 rasterise) unchanged. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [low] Multi-layer GeoPackages: the loader takes the first gpkg_geometry_columns row regardless of geometry type, failing files whose first layer is not lines

**Where:** `app.js:3022`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** loadVectorNetwork selects its table with `SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns LIMIT 1` — the first registered layer, whatever its type. A perfectly valid multi-layer .gpkg whose first layer is polygons or points (common: an OSM extract with landuse polygons + roads lines, or a QGIS project export) parses every geometry blob to null in parseGpkgGeom (which only accepts (Multi)LineString), rasterises 0 cells, and fails with the CRS-mismatch-flavoured message status.net_zero_cells — even though a LineString layer exists in the same file. gpkg_geometry_columns carries geometry_type_name, so the right layer is selectable directly.

**Evidence.**
```
app.js:3022-3024: `const cont = db.exec("SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns LIMIT 1"); if (!cont.length) throw new Error("No gpkg_geometry_columns entry — not a valid .gpkg?"); const tableName = cont[0].values[0][0];`
```

**Fix approach.** Prefer a line layer: first run `SELECT table_name, column_name, srs_id FROM gpkg_geometry_columns WHERE upper(geometry_type_name) IN ('LINESTRING','MULTILINESTRING','MULTICURVE','CURVE') LIMIT 1`; if that returns no rows, fall back to the existing un-filtered `LIMIT 1` query (generic 'GEOMETRY' typed layers and single-layer files keep working). Keep everything downstream (geomCol/srsId coercion, rtree naming) unchanged — the rtree name derives from the selected tableName/geomCol so it follows automatically.

**Tests to run:** `Manual browser: build a two-layer .gpkg with ogr2ogr (polygons layer first, lines layer second), load it, verify the lines layer rasterises; reload the shipped sampa-viario.gpkg to confirm no regression`

**Invariants — do not break:** The srs_id Number() coercion at 3033-3034 (v49 XSS fix C11) must remain on whichever query supplies the row. Single-layer .gpkg behaviour (including the exported network.gpkg/bridges.gpkg round-trip, table names 'network'/'bridges') must be unchanged. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [low] loadOsmNetwork lacks the isGeographic guard the other OSM pulls have — projected DEMs get a misleading 'no intersection' error

**Where:** `app.js:3304`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** loadOsmBridges (app.js:3388) and loadOsmWater (4104) refuse to run on a projected DEM with a dedicated message, and the water-mask comment (3918) claims this 'mirrors the OSM bridge/network guards' — but loadOsmNetwork (the 1B streets pull) has no such guard. It intersects Leaflet lat/lng bounds with the DEM's native-CRS extent (3311-3314: `Math.max(b.getSouth(), originY - H * dy)` etc.), so on a typical UTM DEM (originY ≈ 7,400,000) the intersection test fails and the user gets t("status.osm_no_intersect") — 'query extent doesn't intersect the DEM' — which is wrong and confusing (the map view can be exactly over the DEM). For hypothetical projected DEMs with small local coordinates the mixed-unit bbox could even pass the test and query a nonsense Overpass bbox. CLAUDE.md documents the guard as an invariant for the bridge pull; the streets pull should match.

**Evidence.**
```
app.js:3304-3318: loadOsmNetwork checks only `if (!state.dem)` then computes `const south = Math.max(b.getSouth(), originY - H * dy);` — no `state.dem.isGeographic` check. Contrast 3388-3391 (loadOsmBridges): `if (!state.dem.isGeographic) { status.innerHTML = … t("bridges.osm_need_geographic") …; return; }`.
```

**Fix approach.** In loadOsmNetwork, right after the `if (!state.dem)` guard (line ~3308), add: `if (!state.dem.isGeographic) { status.innerHTML = `<span style="color:#ff6b6b">${t("status.osm_net_geographic")}</span>`; return; }` and add the STRINGS entry `"status.osm_net_geographic": { pt: "A busca OSM precisa de um DEM geográfico (EPSG:4326) — o DEM atual está projetado.", en: "The OSM pull needs a geographic DEM (EPSG:4326) — the current DEM is projected." }` next to the other status.* keys (or reuse the wording of bridges.osm_need_geographic).

**Tests to run:** `Manual browser: load a projected (UTM) GeoTIFF, click 'Puxar do OSM' in 1B, verify the new geographic-DEM message instead of 'no intersection'`

**Invariants — do not break:** New display text must live in the STRINGS table with both pt and en. Do not alter the geographic-path bbox math. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [low] Loader error messages still hardcode English display strings, bypassing the STRINGS/t() i18n table

**Where:** `app.js:3354`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** The v49 fix batch (review finding C14) routed several loader strings through STRINGS/t(), but multiple user-visible error literals in the data loaders were missed. They surface in the status line (wrapped in a translated shell but with an English core) for Portuguese users: (1) app.js:3354 `throw new Error("Overpass returned no highway=* ways in this extent.")` — the bridges equivalent got a key (bridges.none_overpass) in v49 but the streets one did not; (2) app.js:3333 `throw new Error(\`Overpass HTTP ${resp.status} (busy? try again in a minute)\`)` — the STRINGS key status.overpass_http already exists and is used by the bridges (3420) and water (4127) pulls; (3) app.js:2424 "DEM lacks geotransform metadata. Use a properly georeferenced GeoTIFF."; (4) app.js:8706 "Mask GeoTIFF lacks geotransform metadata (ModelPixelScale / tie points)."; (5) app.js:2676 "sql.js didn't load (CDN blocked, or offline before it was ever fetched?)"; (6) app.js:3023 "No gpkg_geometry_columns entry — not a valid .gpkg?" (the io.gpkg_invalid key already exists and is used by importBridgesGpkg at 2835). This violates the project invariant 'UI text goes through the STRINGS table / data-i18n; never hardcode display text in JS'.

**Evidence.**
```
app.js:3354: `if (!lines.length) throw new Error("Overpass returned no highway=* ways in this extent.");` vs the v49-fixed bridges path 3455: `if (!ways.length) throw new Error(t("bridges.none_overpass"));`. app.js:3333: `throw new Error(\`Overpass HTTP ${resp.status} (busy? try again in a minute)\`)` while STRINGS already defines `"status.overpass_http"` (app.js:79).
```

**Fix approach.** Replace each literal with a t() call: 3333 → `throw new Error(t("status.overpass_http", resp.status));` (key exists); 3354 → new key `"status.osm_no_ways": { pt: "O Overpass não retornou vias highway=* nesta extensão.", en: "Overpass returned no highway=* ways in this extent." }`; 3023 → `throw new Error(t("io.gpkg_invalid"));` (key exists); 2424 → new key `"status.dem_no_geotransform"` (pt: "O GeoTIFF não tem metadados de georreferenciamento (ModelPixelScale/tie points)."); 8706 → new key `"status.mask_no_geotransform"` (pt equivalent); 2676 → new key `"status.sqljs_unavailable"` (pt: "sql.js não carregou (CDN bloqueado, ou offline antes do primeiro uso?)"). Add all new keys to the STRINGS table near the existing status.*/io.* entries with both pt and en.

**Tests to run:** `Manual browser: switch language to PT, trigger each failure (projected/no-geotransform tif, non-gpkg file, Overpass empty area) and verify fully-Portuguese status messages; node test-worker-pool.mjs for regression`

**Invariants — do not break:** Every new key needs BOTH pt and en entries; error messages continue to flow through escapeHtml at the innerHTML sinks (they already do — don't change the sinks). t() is defined at app.js:533; keys are dot-namespaced. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [low] Third-party UI strings ignore the language setting: Leaflet-Geoman draw hints and Leaflet zoom-control titles are English-only

**Where:** `app.js:3677`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** Two vendored libraries render their own display text outside the STRINGS pipeline. (1) Drawing barriers/corridors/portals (groups 1C/1D) uses Geoman's enableDraw (app.js:3677) without ever calling map.pm.setLang(), so the interactive hint tooltips Geoman shows while drawing ('Click to place first vertex', 'Finish drawing', etc.) are in its default English even for PT users — and stay English when the app language is EN too by coincidence rather than wiring. Geoman 2.18.3 (loaded via CDN in index.html) ships a 'pt_br' locale. (2) The Leaflet map (app.js:1692) keeps the default zoom control, whose +/- buttons carry hardcoded 'Zoom in'/'Zoom out' title/aria text. Failure scenario: a PT-only user draws a barrier polygon and is guided by English hint tooltips.

**Evidence.**
```
app.js:3677 map.pm.enableDraw(shape, { templineStyle: …, hintlineStyle: …, pathOptions: … }); — no setLang/tooltips option anywhere (grep 'pm.setLang' returns nothing); app.js:1692 const map = L.map("map", { preferCanvas: true, attributionControl: false })… — default zoomControl, default English titles
```

**Fix approach.** (1) After map init (and again inside setLang()), call if (map.pm) map.pm.setLang(currentLang === "pt" ? "pt_br" : "en"); guard with typeof map !== "undefined" in setLang since setLang is defined before the map. (2) Create the map with zoomControl: false and add L.control.zoom({ zoomInTitle: t("map.zoom_in"), zoomOutTitle: t("map.zoom_out") }) — add those two STRINGS keys (pt: 'Aproximar'/'Afastar') — or, simpler, retitle the existing control's buttons inside applyTranslations() by querying .leaflet-control-zoom-in/.leaflet-control-zoom-out and setting title/aria-label from the new keys (this also makes the toggle update them). Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser: set PT, start a barrier draw (1C) and verify Geoman hints are Portuguese; hover the zoom buttons; toggle EN and re-verify`, `node test-worker-pool.mjs (sanity)`

**Invariants — do not break:** Do not add new CDN resources (Geoman's pt_br locale is bundled — no extra script tag; if a separate locale file were needed, it must carry SRI + crossorigin); drawing behaviour, styles and the pm:create flow must be untouched; new keys need pt+en; bump sw.js VERSION.

*(Fix approach independently re-verified as sound.)*

---

### [info] FABDEM mosaic silently degrades when some tiles fail to read — skipped tiles reported only to the console

**Where:** `app.js:2373`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** loadFabdemForView isolates per-tile read failures (a transient network error on one tile's Range request is caught at 2372-2374 and the tile skipped) and only aborts when placed === 0. But when 1..n-1 of the tiles fail, the mosaic loads with NaN holes (nodata) where those tiles should be, and the final status/demSourceUrl report the count of OPENED tiles (line 2399-2400 use opened.length), not placed — the user gets no UI indication that part of their viewport is missing and may attribute the dead zone to FABDEM coverage. The information exists (`placed` vs `opened.length`) but is only visible via console.warn.

**Evidence.**
```
app.js:2372-2374: `} catch (err) { console.warn(\`[fabdem] tile … read failed — skipping:\`, err); }` and 2399-2400: `state.demSourceUrl = \`FABDEM viewport … (${opened.length} tile…)\`; await loadDemFromArrayBuffer(buf, \`FABDEM ${outW}×${outH} (${opened.length} tile…)\`);` — `placed` is never surfaced.
```

**Fix approach.** Track failures (`const failed = opened.length - placed;`) and when failed > 0, after loadDemFromArrayBuffer resolves, overwrite the status line with a warning via a new STRINGS key, e.g. `"status.fabdem_partial": { pt: "Atenção: {0} de {1} tiles FABDEM falharam na leitura — o DEM tem lacunas (nodata). Recarregue para tentar de novo.", en: "Warning: {0} of {1} FABDEM tiles failed to read — the DEM has gaps (nodata). Reload to retry." }` rendered with the amber style used by status.dem_projected (`color:#ff9d3d`). Also use `placed` instead of opened.length in the label/demSourceUrl strings.

**Tests to run:** `Manual browser: load a FABDEM viewport spanning 2+ tiles with devtools request blocking on one tile URL; verify the partial-load warning appears and the DEM still loads with the gap`

**Invariants — do not break:** Keep the all-failed (placed === 0) abort path and the NaN-fill gap semantics unchanged (downstream mask construction depends on Number.isFinite). New text through STRINGS with pt+en. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [info] Geographic degree→metre conversion uses a single mid-latitude cos and the equatorial meridian constant — quantified at ≤0.22% on the flagship DEM: wontfix

**Where:** `app.js:2467`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** app.js:2464-2471 converts geographic DEMs to metres with dxM = dx·111320·cos(latRef) and dyM = dy·110574, latRef = the DEM's middle latitude. Quantified against the flagship 135 M-cell DEM (dem/sampa_geral.tif: 14913×9055 cells, lat −23.373° to −23.806°, 48 km N-S × 73 km E-W, mid-lat −23.59°): the 110574 constant (equatorial meridian) understates the true meridian arc (110752 m/deg at 23.6°S) by −0.16% systematically; the 111320 parallel constant errs −0.05% at mid-latitude; and the single cos makes dxM err −0.22% at the north edge / +0.11% at the south edge. Energy impact is smaller still: only the distance-proportional aRoll/aAero terms scale with the error (the beta·dh climb term uses exact heights), so worst-case energy error is ~0.2% — one to two orders of magnitude below the Crr/CdA/mass parameter uncertainty, and consistent with the code comment's 'good to ~0.3%' claim. Fixing the dominant residual (per-row dx) would require abandoning the uniform-grid scalar dx/dy that the entire engine wire format shares bit-parity with the Rust backend (Params.dx/dy in backend/src/main.rs, the Blob layout, every test) — cost vastly exceeds a <0.25% benefit at the São Paulo extents this app targets.

**Evidence.**
```
// Convert degrees → metres for geographic DEMs using a flat-earth
  // approximation centred on the DEM's middle latitude. For a 5–50 km
  // extent this is good to ~0.3%.
  const latRef = isProbablyGeographic ? originY - (H * dy) / 2 : 0;
  const dxM = isProbablyGeographic ? dx * 111320 * Math.cos((latRef * Math.PI) / 180) : dx;
  const dyM = isProbablyGeographic ? dy * 110574 : dy;
```

**Fix approach.** wontfix: at the flagship DEM's extent the total error is ≤0.22% on horizontal distances and ~0.2% on energies — far below every other model uncertainty — while a per-row dx fix would break the uniform-grid assumption baked into the JS worker, the Rust backend wire format and all bit-parity tests (dx/dy are scalars end-to-end). Two optional, NOT recommended-standalone refinements if this is ever revisited: (a) trivial constant upgrade at app.js:2469/2471 to the latitude-dependent series (m/deg lat = 111132.92 − 559.82·cos2φ + 1.175·cos4φ; m/deg lon = 111412.84·cosφ − 93.5·cos3φ), which halves the systematic bias but silently changes every recomputed field vs previously exported bundles; (b) a README sentence noting the flat-earth approximation degrades to ~1.4% at the edges of continental-scale (3-4°) DEMs. If (a) is ever done, do it inside a normal versioned release (VERSION + changelog trio) and re-run node test-worker-pool.mjs and backend/test-backend.mjs (they use synthetic projected grids, so parity is unaffected, but confirm).

**Invariants — do not break:** If any refinement is attempted: dx/dy must remain per-DEM scalars (uniform grid) — the Rust backend Params and every parity test depend on it; changing the constants changes all computed energies, so it must ship as its own version with a changelog entry, never silently.

*(Fix approach independently re-verified as sound.)*

---

## AJS-3 — app.js pipeline — stage 3: water mask, network overlay, graph-diff render

**Files:** `app.js (lines ~4000-4800)`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [medium] OSM water-mask rasterisation runs fully synchronously on the main thread — multi-second UI freeze on large DEMs, repeated on every #imp-rivers toggle

**Where:** `app.js:4088`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** rebuildOsmWaterMask() (app.js:4083-4100) rasterises ALL OSM water geometry synchronously on the main thread: fillRingsEvenOdd is O(bbox-rows × total-ring-vertices) per body (a large reservoir like Billings with tens of thousands of vertices spanning thousands of DEM rows costs 10^8+ vertex tests alone), and fillSeaFromCoastlines sweeps O(H × coastVertices) + O(W × coastVertices). The only concession is a single setTimeout(0) BEFORE the whole pass (app.js:4153 'let the status paint before the synchronous rasterise'). On the 135 M-cell DEM (H≈10-13k rows) with a full metro-area water pull this freezes the UI for several to tens of seconds — no progress, no input, browser 'page unresponsive' warnings — and the entire cost repeats synchronously every time the user toggles the 'rivers impassable' checkbox (rebuildOsmWaterMask is the toggle's re-apply path). Failure scenario: coastal DEM (e.g. Santos/Baixada) + OSM water pull → tab frozen ~10-30 s; user assumes a hang and kills the tab.

**Evidence.**
```
app.js:4087-4090: `const data = new Uint8Array(W * H); for (const b of g.bodies) fillRingsEvenOdd(b.rings, data, W, H); if (riversImpassable()) for (const rv of g.rivers) rasterPolylineSupercover(rv, data, W, H); fillSeaFromCoastlines(g.coastlines, data, W, H);` and 4153: `await new Promise((r) => setTimeout(r, 0)); // let the status paint before the synchronous rasterise`
```

**Fix approach.** Make rebuildOsmWaterMask() async and yield between work units WITHOUT touching the mirrored helpers: `for (const b of g.bodies) { fillRingsEvenOdd(b.rings, data, W, H); if (++i % 25 === 0) { progressBar.style.width = …; await new Promise((r) => setTimeout(r, 0)); } }`, another yield before the rivers loop and before fillSeaFromCoastlines. Update both callers to await it: loadOsmWater() (already async) and the #imp-rivers change handler (make its listener async). Fill/sweep algorithms, signatures and outputs stay byte-identical.

**Tests to run:** `node test-water-raster.mjs (the mirrors of fillRingsEvenOdd/rasterPolylineSupercover/assembleRings/fillSeaFromCoastlines MUST remain in sync — this fix must not modify those four functions)`, `browser smoke: OSM water pull on a DEM, toggle #imp-rivers, corridors/overlay unchanged`

**Invariants — do not break:** Do NOT modify fillRingsEvenOdd / rasterPolylineSupercover / assembleRings / fillSeaFromCoastlines themselves — they are hand-mirrored in test-water-raster.mjs (same rule as the Rust port); the resulting mask must be bit-identical; applyImpassableRaster/recomputeCorridors ordering unchanged; any new status text through STRINGS/t(); sw.js VERSION + changelog trio on ship.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: Add three things to the spec before handing to a fix-agent:

1. Generation guard against DEM swap: capture `const gen = state.calibrationGen;` at the top of rebuildOsmWaterMask (calibrationGen is already bumped exactly once per DEM load, at app.js:2534, right where state.osmWaterGeom is also nulled — this is the existing idiom used elsewhere in the file, e.g. app.js:8044/8064 `probeGen`/`state.calibrationGen`). Immediately before calling applyImpassableRaster(...), check `if (gen !== state.calibrationGen) return;` and skip status/progress updates too. This prevents a stale-DEM rebuild finishing after a new DEM load from corrupting the new DEM's impassable mask — mirrors the codebase's established generation-guard pattern (state.computeGen/state.calibrationGen) rather than inventing new machinery.

2. Serialize/guard concurrent rebuild invocations from rapid #imp-rivers toggling: disable the `#imp-rivers` checkbox (matching the existing convention at app.js:4109/4162 where the OSM-water button is disabled for the duration of loadOsmWater) for the duration of an in-flight rebuild, or use a simple `state.waterMaskGen` counter bumped on each call so only the LAST-started call's result is applied (same generation-guard technique as item 1, applied to overlapping rebuildOsmWaterMask calls rather than DEM swaps). Without this, two rapid toggles can complete out of start-order (the cheaper OFF-state call can finish before the more expensive ON-state call that started earlier), leaving the applied mask not matching the checkbox's final state.

3. The yield granularity must target the actual cost concentration, not just 'every 25 items': my benchmark shows fillSeaFromCoastlines (a single, un-chunkable-per-invariant call) and any single vertex-dense body/river dominate real-world timing, not the count of separate bodies. Since the four pure functions must stay byte-identical to their test-water-raster.mjs mirrors (per the stated invariant), the fix-agent should add NEW thin async-chunked wrapper entry points (e.g. `fillRingsEvenOddChunked`/`fillSeaFromCoastlinesChunked`) that internally call the SAME per-row math in row-range batches with periodic yields, while leaving fillRingsEvenOdd/rasterPolylineSupercover/assembleRings/fillSeaFromCoastlines themselves untouched and still directly used by test-water-raster.mjs and by any other caller (e.g. line 3609's isolated single-ring call, which doesn't need chunking). Also prefer a time-based yield cadence (e.g. yield when `performance.now() - lastYield > 50`) over a fixed item count of 25, since per-item cost varies by orders of magnitude between a 10-vertex pond and a 30,000-vertex reservoir ring.

testsToRun should add: manually verify (or add a small node/browser check) that starting a rebuild, then loading a new DEM mid-rebuild, does NOT apply the old rebuild's result to the new DEM (state.impassableMeta should reflect the new DEM's own mask/null, not a stale OSM pull).

---

### [medium] Overpass responses are not checked for the `remark` field — timed-out/partial results install as authoritative data or read as 'nothing here'

**Where:** `app.js:4130`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** All three Overpass pulls in app.js (loadOsmNetwork line 3336, loadOsmBridges line 3423, loadOsmWater line 4130) do `const json = await resp.json();` and immediately iterate `json.elements || []` with no validation. The Overpass API frequently returns HTTP 200 with a JSON body containing a `remark` field such as "runtime error: Query timed out in ..." or "...ran out of memory...", accompanied by EMPTY or PARTIAL elements (partial output happens when the error occurs after streaming has begun). Consequences: (a) loadOsmWater with a timed-out query and zero elements prints the SUCCESS-path message t("status.water_none") ("no water found") at line 4148 — the user believes the area has no water; (b) worse, a partially-streamed water result installs an INCOMPLETE impassable mask via rebuildOsmWaterMask/applyImpassableRaster with a normal 'water done, N cells' status — routes then cross rivers/lakes that exist in OSM but were cut off by the timeout; (c) loadOsmNetwork throws the misleading "Overpass returned no highway=* ways in this extent." for what is actually a server timeout. The water query is the most exposed: it queries the FULL DEM extent (not the viewport) with [timeout:120] over 8 way/relation clauses, exactly the shape that times out on large DEMs.

**Evidence.**
```
app.js:4130 `const json = await resp.json();` followed directly by `for (const el of json.elements || []) {` (4135); `grep -n "remark" app.js` returns no matches. Same pattern at 3336 (streets) and 3423 (bridges).
```

**Fix approach.** In each of the three pulls, immediately after `const json = await resp.json();`, add: `if (json.remark) throw new Error(json.remark);`. The existing catch blocks already route the message through the i18n failure wrappers with escapeHtml (status.osm_failed / bridges.pull_failed / status.water_failed), so the server-supplied remark string is safely displayed. Place the check BEFORE any element parsing so partial elements are never consumed.

**Tests to run:** `node test-worker-pool.mjs`, `Manual browser: stub fetch to return {remark: "runtime error: Query timed out", elements: []} for the Overpass URL and verify each pull shows the failure status and mutates no state (state.osmWaterGeom, state.networkMask, state.bridges unchanged)`

**Invariants — do not break:** The remark text is user-derived server data — it MUST keep passing through escapeHtml before innerHTML (the existing catch handlers already do this; don't bypass them). Do not translate the server remark itself. Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Stale cached OSM water geometry silently replaces a later-uploaded impassable mask when the rivers toggle is clicked

**Where:** `app.js:4166`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** state.osmWaterGeom (the cached parsed OSM water geometry) is only cleared on DEM load (app.js:2550) and clearImpassableMask (4223) — loadImpassableMaskFromFile (4166) does NOT clear it. The #imp-rivers checkbox is wired directly to rebuildOsmWaterMask (app.js:1426) and is always enabled. Sequence: user pulls OSM water (caches osmWaterGeom), then uploads a custom mask GeoTIFF (or clicks the hosted water_mask.tif example, which routes through the same loadImpassableMaskFromFile) — imp-meta now shows the file. Later they click 'rios impassáveis' expecting a river toggle: rebuildOsmWaterMask sees the stale osmWaterGeom, re-rasterises it, force-unchecks #impassable-invert, clears the #impassable-file input (4094-4095), and calls applyImpassableRaster(..., "OSM water") — the uploaded mask is silently discarded and replaced by the earlier OSM pull, changing subsequent compute results with only a subtle imp-meta name change as evidence.

**Evidence.**
```
app.js:4166-4178 (loadImpassableMaskFromFile) never touches state.osmWaterGeom; app.js:4084-4085: `const g = state.osmWaterGeom; if (!g || !state.dem || !state.dem.isGeographic) return;` then 4098: `applyImpassableRaster({ … }, "OSM water");`; wiring at 1426: `document.getElementById("imp-rivers")?.addEventListener("change", rebuildOsmWaterMask);`.
```

**Fix approach.** In loadImpassableMaskFromFile, after readMaskGeoTIFF succeeds and before `applyImpassableRaster(raster, file.name)` (line ~4173), add `state.osmWaterGeom = null;` — a file upload supersedes the OSM pull as the mask source, exactly mirroring what clearImpassableMask already does (line 4223). The imp-rivers toggle then becomes a no-op until the next OSM water pull (rebuildOsmWaterMask's `if (!g …) return;` guard).

**Tests to run:** `node test-water-raster.mjs`, `Manual browser: pull OSM water on a DEM, then load the hosted water_mask.tif example, toggle 'rios impassáveis' twice — verify imp-meta keeps showing water_mask.tif and state.impassable is unchanged`

**Invariants — do not break:** Do not break the intended OSM-water flow: pull OSM water → toggle imp-rivers must still re-rasterise from cache without a new Overpass query. Keep the invert-checkbox reset inside rebuildOsmWaterMask (OSM polarity is fixed). Bump sw.js VERSION + changelog trio when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [medium] applyNetworkLinesOverlay creates one Leaflet Polyline per network line — up to ~10^5 layer objects where one MultiPolyline would do

**Where:** `app.js:4304`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** applyNetworkLinesOverlay() (app.js:4287-4314) draws the loaded network with one `L.polyline(line, {...})` PER stored polyline, all with the identical style (black, same weight/opacity, shared canvas renderer). Under the 2 M-vertex retention cap a city-wide street network is easily 50k–200k lines, so toggling 'Draw network' builds that many L.Polyline objects in a synchronous loop (seconds of main-thread freeze, ~100–200 MB of layer bookkeeping), and updateNetworkLineStyle's eachLayer + Leaflet's per-layer canvas redraw pay the same count on every zoomend. Since every line shares one style, Leaflet's native MultiPolyline form (nested latlngs array) renders the identical image with ONE layer object. Failure scenario: user loads the full São Paulo .gpkg network near the vertex cap and ticks 'Draw network' — several-second freeze now, plus noticeably janky zoom (zoomend restyles all layers) for the rest of the session.

**Evidence.**
```
app.js:4302-4311: `const group = L.layerGroup(); for (const line of state.networkLines) { group.addLayer(L.polyline(line, { color: "#000", weight, opacity, interactive: false, renderer })); }`
```

**Fix approach.** Replace the per-line loop with a single MultiPolyline: `state.networkLinesLayer = L.polyline(state.networkLines, { color: "#000", weight, opacity, interactive: false, renderer, pane: "networkPane" }).addTo(map);` (L.Polyline accepts an array of latlng arrays). Adjust updateNetworkLineStyle() to call `state.networkLinesLayer.setStyle({ weight, opacity })` directly when the layer is a single polyline (keep the eachLayer branch only if a layerGroup can still occur).

**Tests to run:** `browser smoke: load a .gpkg and an OSM network, toggle 'Draw network' on/off, change line weight/opacity inputs and zoom — rendering identical, style updates apply`

**Invariants — do not break:** Visual output must be unchanged (same pane, weight, opacity, colour); the vec-render toggle and the over-cap 'net_too_large' status path must keep working; removal path (`state.networkLinesLayer.remove()`) already handles a single layer; sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [medium] buildGraphFieldLayer creates one Leaflet Polyline object per graph edge — 10^5–10^6 layer objects on city-scale networks

**Where:** `app.js:4712`  
**Difficulty:** medium  
**Fix touches:** `app.js`

**Problem.** buildGraphFieldLayer() (app.js:4673-4719) renders the graph-mode passes field by looping over ALL graph edges and calling `group.addLayer(L.polyline([...2 points...], {...}))` per drawable edge. It shares one L.canvas renderer (no per-edge DOM), but each edge is still a full L.Polyline instance (LatLngs, bounds, layer bookkeeping ≈ 0.5–1 KB each) added to the map individually, and Leaflet's canvas renderer re-iterates every path object on each pan/zoom redraw. The network vertex cap is 2,000,000 (VEC_RENDER_VERTEX_CAP), so a São Paulo-scale OSM/gpkg street network yields on the order of 10^5–10^6 edges after junction splitting; a density run puts positive passes on most reached edges (skipZero does not save you). Failure scenario: user loads the city street network, runs graph-mode density with refs spread over the city — renderGraphOverlay freezes the main thread for many seconds building ~500k Polyline objects (~0.5 GB), and every subsequent pan/zoom re-draw iterates all of them, making the map unusably janky; this repeats on every restyle because renderGraphOverlay rebuilds the layer from scratch.

**Evidence.**
```
app.js:4697-4716: `for (let e = 0; e < graph.nEdges; e++) { … group.addLayer(L.polyline([cellFracToLatLng(graph.nodeR[a], graph.nodeC[a]), cellFracToLatLng(graph.nodeR[b], graph.nodeC[b])], { color: col, weight, opacity: op, interactive: false, renderer })); }` — one L.Polyline per edge, unbounded by any cap.
```

**Fix approach.** In buildGraphFieldLayer(), quantise the per-edge intensity t into a fixed number of bins (e.g. 32) and emit ONE L.polyline per non-empty bin using Leaflet's MultiPolyline form (an array of [latlngA, latlngB] pairs as nested latlngs): compute `bin = Math.min(NBINS-1, Math.floor(t * NBINS))` after the gamma step, accumulate `binLatLngs[bin].push([llA, llB])`, then for each non-empty bin create `L.polyline(binLatLngs[bin], { color: colourForBinCentre, opacity: opacityForBinCentre, weight, interactive: false, renderer })`. Colour/opacity are evaluated at the bin centre through the existing tint/greyscale/colormap branches. Keep `group._range = [lo, hi]` and the percentile/user-bound logic unchanged. This reduces 500k layers to ≤32 with imperceptible (≤1/32) colour quantisation.

**Tests to run:** `node test-graph-engine.mjs (engine untouched — must still pass)`, `browser smoke: graph-mode run with passes on a small and a large network; verify corridors look identical, legend range unchanged, pan/zoom is smooth, difference-view tint mode still shows orange with varying opacity`

**Invariants — do not break:** Rendering only — no recompute on style change; keep skipZero semantics (zero/unreached edges never draw); keep the tint (opacity-encoded) vs greyscale vs colormap branches visually equivalent at bin centres; UI strings via STRINGS/t() if any are added; sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [low] Graph-mode difference view encodes the two channels with different intensity transfer functions (orange vectors: 0.3+0.7t opacity; blue raster: rgb*t with alpha t, further double-attenuated by pane+element opacity)

**Where:** `app.js:4708`  
**Difficulty:** medium  
**Fix touches:** `app.js`

**Problem.** In the raster-mode difference view both channels go through renderDualPassesToDataURL with a shared linear ramp (rgb = base*t, alpha = tA+tB, clamped). But in graph mode's vector+raster difference (network passes as vectors, terrain passes as raster): the ORANGE network channel is drawn by buildGraphFieldLayer with constant full-saturation hue and opacity 0.3+0.7t (app.js:4708 — deliberately changed from the 'muddy' rgb*t encoding), while the BLUE terrain channel is rendered by renderFieldToDataURL's tint path as rgb = TERR_BLUE*t AND alpha = t (app.js:7074-7076), composited with mix-blend-mode plus-lighter — an effective ~t^2 premultiplied contribution. On top of that, applyLayerControls applies the passes opacity slider TWICE to the raster channel: once on the imageOverlay element (setOpacity, app.js:7522) and once on the shared passesPane (pp.style.opacity, app.js:7546) because state.graphPassesLayer and state.passesOverlay coexist in the same pane — so at the default 0.7 the blue raster runs at ~0.49 while the orange vectors run at 0.7. Net effect: in the graph difference view, equal traffic reads as much stronger orange than blue, biasing the user's constrained-vs-unconstrained comparison. Failure scenario: graph-mode compare run with density on and no mean filter — a corridor used equally by both scenarios shows clearly orange-dominant instead of blending toward white.

**Evidence.**
```
app.js:4708 (vector channel): `if (tint) { const [tr, tg, tb] = tint; col = rgb(...); op = 0.3 + 0.7 * t; }`
app.js:7074-7076 (raster channel): `r2 = Math.round(tr * t); ... a2 = Math.round(t * 255);`
app.js:7522 + 7546: both `state.passesOverlay.setOpacity(visible ? op : 0)` and `pp.style.opacity = String(visible ? op : 0)` apply when graphPassesLayer exists.
```

**Fix approach.** Two parts. (a) Unify the transfer function: add an option to renderFieldToDataURL's tint branch, e.g. `tintOpacityRamp: true`, that renders constant-hue rgb = tint and alpha = round((0.3+0.7*t)*255) (matching buildGraphFieldLayer line 4708), and pass it from the showTerr terrain-raster call in renderGraphOverlay (app.js:4847-4852) when diffView is true. (b) Fix the double opacity: in applyLayerControls, when both state.graphPassesLayer and state.passesOverlay exist (graph diff view), set the imageOverlay element opacity to 1 (state.passesOverlay.setOpacity(1)) and let the pane opacity be the single control. Leave the raster-mode dual view (renderDualPassesToDataURL) and the single-scenario greyscale paths untouched.

**Tests to run:** `Browser: graph-mode compare run with density, switch scenario picker to 'difference', verify a shared corridor blends toward white and that dragging the passes opacity slider dims both channels equally`, `Raster-mode compare difference view must be pixel-identical to before (its code path untouched)`

**Invariants — do not break:** Do not change renderDualPassesToDataURL (raster-mode difference is the reference rendering); NET_ORANGE/TERR_BLUE additive-complement bases stay (255,165,60)/(0,90,195); style-knob changes must keep re-rendering without recompute; sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [info] Graph-vs-raster route comparison is cross-metric (octile grid inflation vs true polyline lengths) and the tooltip presents Δ without disclosing it

**Where:** `app.js:4538`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** The v48 compare feature overlays the network (graph/constrained) route against the unconstrained TERRAIN route and shows both energies/lengths plus Δ = network − terrain (compareRoutesContent, app.js:4538-4557). The two numbers are not measured in the same metric: the terrain route is an 8-connected grid path, so its length and distance-proportional energy terms (aRoll, aAero) carry octile inflation (up to ~8% above the true geometric path for general headings) and cell-centre heights, while the network route pays exact polyline lengths and profile-sampled heights. Small positive or negative Δ values (within roughly the octile inflation band) are therefore methodological noise, and the UI presents them as a physical energy cost of staying on the network with no caveat. This is inherent to comparing the two engines — the correct fix is disclosure, not recomputation (a raster path's length IS its grid-polyline length; the inflation comes from the 8-direction movement constraint itself).

**Evidence.**
```
// Δ = network − terrain ≥ 0: the energy cost of staying on the network.
  if (Number.isFinite(netE) && Number.isFinite(terrE)) {
    const d = netE - terrE;
    const pct = terrE > 0 ? (d / terrE) * 100 : null;
    html += `<br/>${escapeHtml(t("route.delta"))}: ...
```

**Fix approach.** Add a STRINGS entry `route.compare_metric_note` with PT ≈ "Nota: a rota de terreno segue a grade 8-conectada (comprimento até ~8% acima do geométrico) e alturas por célula; a rota da rede usa o comprimento real das polilinhas — Δ pequenos ficam dentro dessa diferença metodológica." and an equivalent EN translation. Append it to the HTML returned by compareRoutesContent (app.js:4538) as a final muted line, e.g. `<br/><span style="opacity:.65;font-size:10px">${escapeHtml(t("route.compare_metric_note"))}</span>` (it feeds bindTooltip AND bindPopup via bindRouteCompare, app.js:4563). Also add one sentence to the help modal's network/compare paragraph (the STRINGS help.p.* block near help.h.network, app.js:511) stating the same cross-metric caveat for the difference SCENARIO fields (graph-mode energyAlt difference is the same comparison rasterised). Bump sw.js VERSION and move the changelog trio (user-visible change).

**Tests to run:** `Browser: run a graph-mode compare with a destination, hover/tap both route lines — note renders in PT and EN (toggle language)`, `node test-worker-pool.mjs (sanity)`

**Invariants — do not break:** All display text through STRINGS/t() (both PT and EN keys — never hardcode); user-derived values through escapeHtml before innerHTML (labels here come from STRINGS but keep the defensive escaping pattern); do not change any computed value — disclosure only; VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

## AJS-4 — app.js pipeline — stage 4: worker pools, memory, cloud VM client, calibration

**Files:** `app.js (lines ~4800-8000)`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [medium] Density-pool workers are never terminated when their slice finishes, so compare/interp phases stack a second full worker set on top of the finished pool

**Where:** `app.js:5948`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** In app.js, computeDensityField() (the browser multi-reference density pool) resolves its promise inside each worker's 'done' handler after merging accumulators, but never calls w.terminate() — the finished workers stay in state.workers until the NEXT cancelActiveCompute()/computeDone(). The app's own hygiene rule (computeDone, app.js:5677 'Terminate now rather than waiting for the next run — finished workers pin their DEM copy + Dijkstra buffers otherwise') treats termination as the reliable memory-release mechanism, and worker-internal GC timing is unspecified. Consequences at the flagship 135 M-cell scale: (1) startDensityCompare() runs scenario A then scenario B sequentially — A's pool worker (38 B/cell, ~55 round ≈ 5.1–7.4 GB) is still alive while B's pool allocates the same again, roughly doubling the honest per-worker budget that densityPoolSize() computed; (2) a network-constrained density run starts the runInterp() band pool while the Dijkstra pool workers are still alive, directly contradicting interpPoolSize()'s stated assumption (app.js:7785 'The interp runs AFTER the Dijkstra workers are freed … so this RAM is genuinely available'). Failure scenario: 16 GB machine, 135 M-cell DEM, round-trip density with 'Comparar com cenário sem rede' in Browser mode — scenario B's worker allocation lands on top of scenario A's un-reclaimed ~7 GB worker and the tab OOM-crashes (or swaps for minutes), where sequential execution was supposed to fit.

**Evidence.**
```
app.js:5942-5956: `} else if (m.kind === "done") { for (let i = 0; i < N; i++) density[i] += m.density[i]; … if (--remaining === 0) { … resolve({ energy, passes: density }); }` — no w.terminate() anywhere in computeDensityField; contrast computeDone at 5677-5680: `// Terminate now rather than waiting for the next run — finished workers pin their DEM copy + Dijkstra buffers otherwise.\n    for (const w of state.workers) w.terminate();`
```

**Fix approach.** In app.js computeDensityField()'s spawnWorker 'done' handler (the `m.kind === "done"` branch around line 5942), after the three merge loops and before/after `resolve(...)`, terminate and unregister the finished worker: `w.terminate(); const ix = state.workers.indexOf(w); if (ix >= 0) state.workers.splice(ix, 1);`. The message payload (m.density/m.energySum/m.energyCount) has already been delivered, so terminating there is safe. Do the same in the 'error' branch is NOT needed (computeFailed→cancelActiveCompute already terminates all). This makes startDensityCompare's scenario A pool release before scenario B spawns, and makes runInterp's 'Dijkstra workers are freed' assumption true.

**Tests to run:** `node test-worker-pool.mjs`, `browser smoke: density run with K>1 refs (pool>1), density + compare run, density + network-interp run — all must complete and render`

**Invariants — do not break:** Do not touch energy-worker.js or the merge/normalisation order (pooled-density ≡ single-run equivalence and Float64 merge accumulators are load-bearing); keep the generation guard (gen === state.computeGen) semantics; cancelActiveCompute() must still safely iterate state.workers; bump sw.js VERSION + move the changelog trio (CHANGELOG.md, index.html <details id="changelog">, sw.js comment) when shipping.

*(Fix approach independently re-verified as sound.)*

---

### [medium] /single wire-format change (f32→f64 passes) hard-fails against every pre-v49 backend binary — including the cloud VM's boot-disk-cached binary — with no fallback and no version gate

**Where:** `app.js:6124`  
**Difficulty:** small  
**Fix touches:** `app.js`, `backend/README.md`

**Problem.** v49 changed the POST /single response layout: passes went from f32×N to f64×N (backend/src/main.rs subtree_passes_f64), and app.js's decoder now requires exactly `4 + jlen + 4*N + 8*N` bytes when passes are requested. A pre-v49 backend returns `4 + jlen + 4*N + 4*N`, so the length check throws — and by explicit design that error path calls computeFailed() and does NOT fall back to the browser pool ("backend HAS answered — must surface as a failure"). There is no /health version gate anywhere (pingBackendHealth only reads cores/mem_budget_bytes). Two persistent stale-binary populations exist: (a) self-hosted localhost users who don't rerun `cargo build --release` (README documents the new format but not that the old binary now breaks); (b) the cloud compute VM — vm/startup-script.sh lines 60-64 deliberately cache the compiled binary on the boot disk across stop/start ("só o PRIMEIRO boot compila"), and the orchestrator stops rather than deletes the VM, so the v48 binary survives indefinitely. Failure scenario: deploy the v49 app, then run any from/to/round compute with "Calcular passes" checked in Cloud or Localhost mode against an existing VM/binary → the run dies with the raw error "backend response N B, expected M B" on every attempt, until someone manually rebuilds the backend or deletes /opt/simujoules/simujoules-backend on the VM. Note the /density decoder (app.js:6060) already tolerates old backends (unaligned-JSON fallback), so backward-compatible decoding is the established house pattern; /single got none.

**Evidence.**
```
app.js:6124-6126:
        const expect = 4 + jlen + 4 * N + (wantPasses ? 8 * N : 0);
        if (buf.byteLength !== expect) {
          throw new Error(`backend response ${buf.byteLength} B, expected ${expect} B`);
vm/startup-script.sh:60-64:
  # Cache do disco de boot: o binário persiste entre stop/start, então só o
  # PRIMEIRO boot compila. ...
  echo "-- binário já compilado ($BIN_PATH) — pulando clone+build --"
```

**Fix approach.** Make the app.js /single decoder accept both layouts, mirroring the /density decoder's old-backend tolerance. In startSingleBackend (app.js ~6121-6137): when wantPasses, compute `const expectF64 = 4 + jlen + 4*N + 8*N;` and `const expectF32 = 4 + jlen + 4*N + 4*N;`; accept byteLength === expectF64 (decode Float64Array as today) OR byteLength === expectF32 (decode `new Float32Array(buf.slice(off, off + 4*N))` and widen via `Float64Array.from(...)`, plus `console.warn("[backend] pre-v49 backend detected: /single passes received as f32 — rebuild the backend (cargo build --release) for exact counts above 2^24")`). Keep the strict single-value check when !wantPasses. Additionally document in backend/README.md and CHANGELOG.md that pre-v49 backends must be rebuilt and the cloud VM binary refreshed (delete /opt/simujoules/simujoules-backend or delete the VM so the next boot rebuilds — provide the command, do not run it).

**Tests to run:** `cd backend && cargo build --release && node test-backend.mjs`, `node test-worker-pool.mjs`

**Invariants — do not break:** Do NOT change the Rust wire format again (test-backend.mjs enforces bit-parity on the f64 wire; the f64 passes fix is correct and must stay). Do not reintroduce a silent browser-pool fallback after the backend has answered — the legacy-layout branch is a decode, not a fallback. The widened f32 counts are only inexact above 2^24 (the pre-existing pre-v49 behaviour), which is acceptable for the compat path; say so in the console message. Console messages may be English; any NEW user-facing status text must go through STRINGS/t(). app.js is a served file: bump sw.js VERSION + changelog trio in lockstep, one release commit authored as Claude with Co-Authored-By Danilo.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Compare-pair runs two full-grid single-source workers in parallel with no memory budget — parents/passes arrays can OOM the tab on huge DEMs

**Where:** `app.js:6226`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** startComparePair (app.js:6181-6250) always spawns TWO workers in parallel (wA primary + wB unconstrained partner). Since v48 the partner keeps baseMsg's goalR/goalC (app.js:5768) to trace the terrain route, which forces the worker to allocate a full-grid Int32 parents array (+4 B/cell), and it inherits wantPasses (Float64 passes +8 B/cell plus Int32 order +4 B/cell). Each worker's resident set is roughly height(4)+mask(1)+E(4)+settled(1)+parents(4)+order(4)+passes(8) ≈ 26 B/cell plus heap — ~3.5 GB per worker on the flagship 135 M-cell DEM, ~7 GB for the pair, more in round mode (two search scratch sets). Unlike density (densityPoolSize, app.js:7766, budgets ~38-55 B/cell/worker against navigator.deviceMemory) and interp (interpPoolSize, app.js:7788), nothing budgets this pair: a user enabling 'Comparar com cenário sem rede' with passes + a destination on a big DEM crashes the tab with no warning.

**Evidence.**
```
const wB = spawnWorker((m) => { ... });
    {
      // ... We KEEP baseMsg's goalR/goalC so the
      // unconstrained partner ALSO traces the best TERRAIN route ...
      const { height, mask, transfer } = buildComputeGrid();
      wB.postMessage({ ...baseMsg, height, mask, networkMask: null, wantTopN: false, ... });
```

**Fix approach.** In startComparePair (app.js:6181), gate parallelism on the same deviceMemory budget formula the pool sizers use: `const perWorker = (baseMsg.mode === "round" ? 55 : 38) * N; const memBudget = Math.max(1.5e9, (navigator.deviceMemory || 4) * 1e9 * 0.45); const parallelOk = 2 * perWorker <= memBudget;` (38/55 are the documented per-worker B/cell constants from densityPoolSize at app.js:7766-7772 — slightly conservative for this pair, which is fine). Restructure: extract the existing wB spawn+postMessage block (lines 6226-6249) into a local `const startSecondary = () => {...}`; when parallelOk, call it immediately (current behaviour, byte-identical results); when not, call it from wA's 'done' branch (after `primary = m;`, before maybeFinish()), so the two full-grid workers are never resident together — peak memory halves at the cost of serialized wall time. maybeFinish() already tolerates either completion order. Optionally reuse the split-progress pattern of startDensityCompare (progressBase 0/0.5, progressScale 0.5) for the sequential case; the primary is the only progress reporter today, so this is cosmetic. Leave computeUnconstrainedEnergy (the graph-mode partner, app.js:6313) alone — it already runs after the graph result, one raster worker at a time.

**Tests to run:** `node test-worker-pool.mjs`, `browser: from/to compare with destination + passes on a small DEM — identical energyAlt/pathAlt output in both parallel and sequential paths (force sequential by temporarily setting the threshold to 0)`, `browser: cancel mid-compare (cancelActiveCompute) in the sequential path — no orphan worker, generation guard drops late messages`

**Invariants — do not break:** Generation-guard semantics: the sequential secondary must still be spawned via spawnWorker (which registers into state.workers for cancelActiveCompute termination) and its results dropped when gen !== state.computeGen; do not change worker message shapes or computeDone's contract; densityPoolSize()/predictComputeMs() sharing must not drift (this fix reuses their constants, it must not fork the budget formula into a third divergent expression — consider extracting `memBudgetBytes()` used by densityPoolSize, interpPoolSize and this check); sw.js VERSION + changelog trio.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: 1. (Required for the fix to actually work) In the sequential branch, terminate the primary worker and drop it from `state.workers` immediately after capturing its result and before calling `startSecondary()`, e.g. right after `primary = m;` in wA's onMessage: `wA.terminate(); state.workers = state.workers.filter(w => w !== wA);`. Without this, wA's full-grid buffers (documented as pinned-until-terminated by the app's own `computeDone` comment at app.js:5677-5678) stay resident the whole time wB runs, and peak memory is unchanged from today — the fix's central claim ("two full-grid workers are never resident together") only holds once this is added. `computeDone`'s later `for (const w of state.workers) w.terminate()` is a no-op on an already-removed/terminated worker, so this is safe to add.
2. (Should fix, not blocking) wB's onMessage handler (app.js:6226-6229) only branches on `"done"`/`"error"` — it silently drops `"progress"` messages, which `dijkstra()` does post during a single-source search (energy-worker.js:238). In the sequential fallback this means the progress bar (fed only by wA today) will sit at ~100% for the entire second (potentially equally long) pass with zero feedback, on exactly the huge-DEM runs this fix targets — worse than "cosmetic" for that audience. Wire wB's progress through the same split-progress pattern the fix already suggests (`startDensityCompare`'s progressBase/progressScale, app.js:6283-6304) rather than treating it as optional.
3. (Nice to have) `predictComputeMs`/`currentRunOpts` (app.js:8195-8290) never read `vec-compare` for the raster from/to/round path at all, so the pre-flight ETA is already blind to the compare partner's cost; after this fix the sequential branch roughly doubles real wall time on huge DEMs specifically, making that blind spot worse exactly where the fix applies. Not required to land the memory fix, but worth a follow-up so the ETA doesn't quietly become ~2x optimistic for the users this change affects most.
4. (Nice to have, matches the finding's own invariants note) `densityPoolSize` and `interpPoolSize` already duplicate the identical `memBudget = Math.max(1.5e9, devMemGB*1e9*0.45)` line; before adding a third copy in `startComparePair`, extract a shared `memBudgetBytes()` helper as the finding itself suggests, to remove the 3-way drift risk rather than just noting it.

---

### [medium] Graph-mode IDW interp workers are never terminated — they pin ~0.8 GB each (135 M-cell DEM) until the next compute

**Where:** `app.js:6344`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** In app.js startGraphCompute()'s finishGraph(), state.workers is terminated at line 6390 — but the graphInterp() helper (line 6339) then spawns 1–2 NEW workers (one for the rasterised graph energy eGrid, one for energyAlt.difference on compare runs) via spawnWorker, which pushes them back into state.workers. Their 'interp-done'/'error' handlers resolve the promise but never terminate the worker, and the graph path never calls computeDone() (whose terminate loop is the app's only end-of-run cleanup). The workers idle until the user's NEXT compute or DEM/network change calls cancelActiveCompute(). Each interp worker received a transferred full-grid energy (4 B/cell) + seedMask (1) + mask (1) and internally allocated an out copy (4), seedMask (1) and an Int32 chamfer grid (4) in idwFill — ~15 B/cell of worker heap whose release now depends on unscheduled worker GC. Failure scenario: 135 M-cell DEM, graph mode ('follow the vectors') with 'interpolate network' on and compare enabled — after the run completes, ~1.6–2 GB (two workers) stays pinned while the user pans/restyles the map (which itself allocates GB-scale render temporaries), pushing an otherwise-fine session into swap or a tab kill.

**Evidence.**
```
app.js:6339-6353: `const graphInterp = (field) => new Promise((resolve) => { … const w = spawnWorker((m) => { if (m.kind === "interp-done") { if (gen !== state.computeGen) return; resolve(m.energy); } else if (m.kind === "error") { console.warn("[graph interp]", m.message); resolve(null); } });` — no w.terminate(); finishGraph's cleanup at 6390 (`for (const w of state.workers) w.terminate(); state.workers = [];`) runs BEFORE graphInterp is called at 6413/6421.
```

**Fix approach.** In app.js graphInterp() (inside startGraphCompute, ~line 6339), terminate the worker in both message branches: in the 'interp-done' branch call `w.terminate(); const ix = state.workers.indexOf(w); if (ix >= 0) state.workers.splice(ix, 1);` before resolve (also when the gen-mismatch early-return fires, termination is harmless — cancelActiveCompute already did it), and the same in the 'error' branch before `resolve(null)`.

**Tests to run:** `node test-graph-engine.mjs`, `browser smoke: graph-mode run with net-interp on (energy field fills), graph-mode compare run (difference field fills), then immediately run a second compute — no errors`

**Invariants — do not break:** graphInterp transfers field.buffer into the worker (the caller must not reuse it) — keep that contract; do not terminate before the interp-done message is delivered; generation-guard semantics unchanged; sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Passes restyle pipeline allocates full-resolution Float64 temporaries (~2–4 GB transient per 'Atualizar estilo' click on the 135 M-cell target)

**Where:** `app.js:6880`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** The passes/density render path is stride-downsampled at the CANVAS (overlayCanvasDims caps at 10 M px) but runs its numeric prefilters at FULL grid resolution in Float64: boxBlur2D() allocates `tmp = new Float64Array(N)` plus `out = new Float64Array(N)` (16 B/cell), and passesAsDensity() allocates another full Float64Array (8 B/cell) whenever the field is raw counts. The default UI ships passes-mean-window=5 (index.html:2033), so EVERY restyle of a passes layer on a 135 M-cell DEM allocates ~2.2 GB (single view: convert 1.08 GB + blur tmp 1.08 GB + blur out 1.08 GB, tmp freed mid-way) and burns ~1–2 s of main-thread blur; the compare 'difference' dual view (renderDualPassesToDataURL, app.js:7116-7126) converts AND blurs BOTH channels — ~4+ GB of transient Float64 on top of the ~3.8 GB compare result already retained in state.lastResult. Failure scenario: 135 M-cell compare run with passes, user switches the scenario picker to 'difference' or clicks 'Atualizar estilo' — the tab's memory spikes by several GB per click; on an 8 GB machine (or a 16 GB one with the un-terminated workers above) this OOM-kills the tab, losing the minutes-long compute result. Display precision does not need f64: the percentile bounds are already reservoir-sampled into a Float32Array, and the canvas quantises to 8-bit.

**Evidence.**
```
app.js:6880/6899 (boxBlur2D): `const tmp = new Float64Array(N); … const out = new Float64Array(N);`; app.js:6944 (passesAsDensity): `const out = new Float64Array(field.length);`; index.html:2033: `<input type="number" id="passes-mean-window" value="5" …>`; renderDualPassesToDataURL app.js:7125-7126 blurs both: `const a = winA > 1 ? boxBlur2D(constrained, W, H, winA) : constrained; const b = winB > 1 ? boxBlur2D(unconstrained, W, H, winB) : unconstrained;`
```

**Fix approach.** Switch the render-only temporaries to Float32: in boxBlur2D() make `tmp` and `out` `new Float32Array(N)` (the sliding-window accumulators `sum`/`count` are already scalar f64, so per-cell stores just round once to f32 — invisible after 8-bit canvas quantisation), and in passesAsDensity() make `out` `new Float32Array(field.length)` (density values ~1e-17·counts are far above the f32 denormal floor). This halves transient memory on every restyle for both renderFieldToDataURL and renderDualPassesToDataURL and for buildGraphFieldLayer's per-edge conversion. Do NOT mutate or replace the cached state.lastResult.passes / passesAlt arrays themselves.

**Tests to run:** `node test-worker-pool.mjs (guards that no worker file was touched)`, `browser smoke: compute with passes on a real DEM, click 'Atualizar estilo' with mean-window 1/5/25, compare run → 'difference' dual view renders identically (visually) and legend bounds stay sane`

**Invariants — do not break:** Style-knob changes must re-render cached arrays and NEVER trigger a recompute; do not change what is stored in state.lastResult (bundle export writes r.passes as float64 GeoTIFF and must keep byte-identical output); do not touch energy-worker.js; sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [medium] interpPoolSize budgets 6 B/cell per band worker but the worker actually holds ~15 B/cell — the interp pool can overshoot its memory budget ~2.5×

**Where:** `app.js:7792`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** interpPoolSize() (app.js:7788-7799) caps the IDW-fill band pool with `memBudget / (6 * N)`, documented as 'energy f32 + mask + networkMask' per worker. But each band worker's actual resident set in energy-worker.js idwFill() is: the 3 transferred inputs (6 B/cell) PLUS `out = new Float32Array(E)` (4, line 881), `seedMask = new Uint8Array(N)` (1, line 900) and the chamfer prefilter `dist = new Int32Array(N)` (4, chamferFar3 line 815) — ~15 B/cell, plus the returned band slice (4·N/P). The pool model that exists specifically so runner and estimator 'can never drift' from reality is itself off by 2.5×. Failure scenario: deviceMemory=8 machine (memBudget 3.6 GB), 50 M-cell DEM, network-constrained density with interp: memCap = 3.6e9/(6·50e6) = 12, so cores (say 7) binds and 7 band workers spawn holding ~7 × 0.79 GB ≈ 5.5 GB against the 3.6 GB budget — combined with the not-yet-terminated Dijkstra pool workers (separate finding) this is the difference between fitting and OOM.

**Evidence.**
```
app.js:7782-7792: `// Each band worker holds the FULL grid (~6·N bytes: energy f32 + mask + networkMask) … const memCap = Math.max(1, Math.floor(memBudget / (6 * N)));` vs energy-worker.js:881 `const out = new Float32Array(E);`, 900 `const seedMask = new Uint8Array(N);`, 811-815 `function chamferFar3(…) { … const dist = new Int32Array(N);`
```

**Fix approach.** In app.js interpPoolSize(), change the per-worker constant from `6 * N` to `15 * N` and update the comment to enumerate the real resident set (inputs 6 + idwFill out 4 + seedMask 1 + Int32 chamfer 4; band slice excluded as ≤4/P). No other call site: predictInterpMs shares interpPoolSize, so runner and estimator stay in lockstep automatically.

**Tests to run:** `node test-worker-pool.mjs`, `browser smoke: network-constrained run with interp on a mid-size DEM — banded output identical (bands are row-independent, so pool size cannot change the merged field)`

**Invariants — do not break:** interpPoolSize must remain the SINGLE shared helper for runner AND estimate (no drift); the merged interp output must be byte-identical for any pool size (it is — bands are independent rows); do not change idwFill itself (its output is part of the parity/regression surface); sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [medium] ensureCloudVm never re-issues /cloud/start, so a run started while the VM is STOPPING (the default stop-after-each-run window) stalls 5 minutes and falls back to the browser

**Where:** `app.js:7945`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** The cloud client POSTs /cloud/start exactly once (app.js line 7895) and then only polls the data-plane /health and GET /cloud/status. orchestrator/main.py `ensure_up` takes no action for a STOPPING instance (line 512: `else: # PROVISIONING / STOPPING — transição em curso` just returns eta=30) — correctly, since GCP cannot start a stopping instance. But once the instance reaches STOPPED, nobody ever issues the start: /cloud/status is read-only. Because the app's default behaviour is stop-after-each-run (computeDone → stopCloudVm) and a GCP stop takes ~30-90 s, a user who tweaks a parameter and hits Run again within ~a minute of the previous cloud run lands exactly in this window: the VM stays STOPPED, /health never answers, and after the full boot deadline (5 min) the run throws boot_failed and falls back to the far slower in-browser pool — with the misleading 'Falha ao iniciar a VM da nuvem' message.

**Evidence.**
```
app.js:7895 `started = await cloudFetchJson(`${orchUrl}/cloud/start`, { method: "POST", ... })` (only call); poll loop :7944-7952 only does `cloudFetchJson(`${orchUrl}/cloud/status`, { method: "GET", ... })`; main.py:512-513 `else:  # PROVISIONING / STOPPING — transição em curso\n        eta = 30` issues no start.
```

**Fix approach.** In `ensureCloudVm`'s `for (;;)` poll loop in app.js, after the /cloud/status fetch succeeds, re-kick the idempotent start when the control plane reports the instance startable: `if (st.state === "STOPPED" || st.state === "ABSENT") { try { await cloudFetchJson(`${orchUrl}/cloud/start`, { method: "POST", timeoutMs: 15000 }); } catch (err) { if (err.status === 401) throw Object.assign(new Error("auth_failed"), { reason: "auth_failed", cause: err }); } }`. /cloud/start is documented idempotent (creates if absent, starts if stopped, no-op if running), so repeated kicks are safe; the existing isStale()/deadline guards bound the loop.

**Tests to run:** `Load the app in a browser (syntax check) and exercise Cloud mode against `DRY_RUN=1 CLOUD_AUTH_TOKEN=x REAP_TOKEN=y python3 orchestrator/main.py` (its fake state machine reproduces the STOPPING→STOPPED window: run, let it stop, immediately run again)`, `node test-worker-pool.mjs (regression, engine untouched)`

**Invariants — do not break:** Do not change the /cloud/* JSON contracts. Any new user-visible text must go through the STRINGS/t() i18n table (this fix needs none). If this app.js change ships, bump sw.js VERSION and move the changelog trio (CHANGELOG.md + index.html help-modal <details> + sw.js comment) together.

*(Fix approach independently re-verified as sound.)*

---

### [low] Backend /density zero-copy view retains the entire response buffer — ~540 MB dead weight pinned in state.lastResult on the 135 M-cell target

**Where:** `app.js:6062`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** startDensityBackend() parses the native backend's /density response by taking a zero-copy Float64Array VIEW over the response ArrayBuffer for the density block (`new Float64Array(buf, off, N)`) when the offset is 8-byte aligned (current backends). That view flows through finishDensityOutputs → computeDone → state.lastResult.passes, so the WHOLE response buffer — 4-byte header + JSON meta + 8·N density + 4·N energy — stays reachable for the lifetime of the result (until the next compute/DEM load). The adjacent comment (6065-6067) explains that energy is copied precisely to avoid 'dragging the whole response buffer along', but the density view does exactly that: the 4·N energy bytes are retained TWICE (once as the copied Float32Array, once inside buf). On the 135 M-cell DEM that is ~540 MB of permanently-pinned dead weight per backend density run. Failure scenario: 135 M-cell DEM computed via the Cloud/Localhost backend, then the user keeps working (restyles, exports) — the session carries ~540 MB more than the equivalent browser-pool run, which contributes to restyle-time OOM on smaller machines.

**Evidence.**
```
app.js:6060-6068: `const aligned = off % 8 === 0; const density = aligned ? new Float64Array(buf, off, N) : new Float64Array(buf.slice(off, off + 8 * N)); off += 8 * N; // Energy is always copied out: … a view would drag the whole response buffer — density included — along and detach it. const energy = new Float32Array(buf.slice(off, off + 4 * N));`
```

**Fix approach.** In startDensityBackend(), always slice-copy the density block: replace the `aligned ? view : slice` ternary with `const density = new Float64Array(buf.slice(off, off + 8 * N));` and delete the `aligned` variable + the zero-copy comment (update it to note the copy trades a transient +8·N allocation during parsing for not retaining the 12·N response buffer). Leave startSingleBackend() alone (it already slice-copies).

**Tests to run:** `cd backend && cargo build --release && node test-backend.mjs (wire-format parity unaffected but proves the pipeline end-to-end)`, `browser smoke: backend density run renders and bundle-exports identically`

**Invariants — do not break:** Do not change the wire format or backend/src/main.rs; the parsed density values must be numerically identical (a slice copy is); errors after the fetch must still surface via computeFailed, never fall through to the browser-pool fallback; sw.js VERSION + changelog trio on ship.

*(Fix approach independently re-verified as sound.)*

---

### [low] Graph-mode completion path never retries a failed calibration probe, so the time estimate stays blank permanently for graph users

**Where:** `app.js:6403`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** v49 added calibration-probe error recovery: on probe failure state.calibrationFailed is set and estimateRunTime() blanks the estimate instead of showing "estimating…" forever, with the comment promising "computeDone retries the probe after each run". The retry (`if (!state.calibration) startCalibrationProbe();`, app.js:5701) lives only in the GRID computeDone closure. The graph-mode completion path finishGraph (app.js ~6389-6434) terminates workers, updates estimates and renders, but has no probe retry. estimateRunTime() (app.js:8298-8303) early-returns blank whenever state.calibration is null — including for graph-mode estimates, which are gated behind the same `if (!cal)` check. Failure scenario: the probe worker errors at DEM load (e.g. transient OOM on a huge DEM); the user works exclusively in graph mode ("seguir os vetores") — every graph compute completes but the pre-flight estimate remains blank for the rest of the session, despite the v49 changelog claiming the estimate recovers after a run. Grid users recover; graph-only users don't.

**Evidence.**
```
app.js:5699-5701 (grid path only):
    // The calibration probe is skipped while a compute runs — if this DEM
    // still has no calibration, run it now that the cores are free.
    if (!state.calibration) startCalibrationProbe();
finishGraph (app.js:6389-6403) contains no startCalibrationProbe call; estimateRunTime gates ALL estimates on `if (!cal) { out.textContent = state.calibrationFailed ? "" : t("estimate.calibrating"); return; }`
```

**Fix approach.** In finishGraph (app.js, right after `if (!energyAlt) { updateEstimateCorrection(result.elapsedMs, 0); estimateRunTime(); }` at ~line 6403), add the same retry as the grid computeDone: `if (!state.calibration) startCalibrationProbe();`. startCalibrationProbe is already generation-guarded (state.calibrationGen) and self-skips while a compute runs, so no extra guards are needed.

**Tests to run:** `node test-worker-pool.mjs`

**Invariants — do not break:** startCalibrationProbe must only run when no compute is in flight (finishGraph is the completion point, so this holds). Do not reset state.calibrationFailed anywhere except the existing sites (DEM load, markBridgesDirty, markImpassableDirty, startCalibrationProbe itself). app.js is served: bump sw.js VERSION + changelog trio if shipped, one release commit authored as Claude with Co-Authored-By Danilo.

*(Fix approach independently re-verified as sound.)*

---

### [low] Residual hardcoded English display strings bypass the STRINGS/t() i18n path (stats panel, DEM meta, marker/route tooltips, colormap groups, Overpass errors)

**Where:** `app.js:6646`  
**Difficulty:** medium  
**Fix touches:** `app.js`

**Problem.** CLAUDE.md forbids hardcoded display text in JS (it clobbers the PT translation), and the v49 fix batch routed several such strings through STRINGS/t() (previous-review C14/I8) but missed a cluster. Portuguese-language users (the default: currentLang starts 'pt') see English or mixed-language text at these sites: (1) renderResult() stats panel, sidebar group '3A. Estatisticas', app.js lines 6646-6673 — labels 'max E:', 'time:', 'max passes:', the '{N} route(s):' line, ', shared', 'path E:', 'length:' are English template literals pushed into resultMeta.innerHTML, right next to the properly i18n'd t("route.terrain_meta") and t("route.round_note") in the same array, so the panel is mixed-language after every compute. (2) app.js:6854 route polyline hover tooltip is a literal 'route {i} · E {x} · {y} km'. (3) app.js:2578-2582 demMeta.innerHTML hardcodes 'cells, cell' and 'origin', and formatCoverage() at app.js:8426 appends the English word 'coverage' — shown in group 1A after every DEM load. (4) app.js:4996, 5005, 5017 bind Leaflet marker tooltips "Source"/"Destination"; app.js:5600/5605 pass the same English literals as {0} into t("status.snap_failed_label") so the PT status reads 'Source não pode ser agarrado — ...'; app.js:9799/9805 pass them to placeMarker(), which at 9790 uses (label === "Source") to pick the marker icon. (5) app.js:4170 sets the #imp-meta element to the literal 'Reading {file.name}…' while loading a barrier-mask GeoTIFF. (6) app.js:3333 throws a literal 'Overpass HTTP {status} (busy? try again in a minute)' although the exact key status.overpass_http exists and is used by the sibling call sites at 3420 and 4127; app.js:3354 throws the literal 'Overpass returned no highway=* ways in this extent.' — both surface to PT users via t("status.osm_failed", err.message) as mixed-language status text. (7) COLORCET_GROUPS at app.js:8508-8520 hardcodes optgroup labels ('Linear', 'Diverging', 'Rainbow', 'Isoluminant', 'Cyclic', 'Colour-blind safe linear', 'Tritan-safe diverging', ...) shown in both colormap selects (populated at app.js:1058-1072 and ~1147). Failure scenario: a PT user loads a DEM, runs a compute with top-N routes on, and the DEM meta, the whole statistics panel, the route tooltips and marker tooltips are English; if a constraining network cannot snap the origin, the error message mixes 'Source' into a Portuguese sentence.

**Evidence.**
```
app.js:6646 meta.push(`max E: <span class="v">${eHi.toExponential(2)}</span>`); … 6648 meta.push(`time: <span class="v">${elapsedMs.toFixed(0)} ms</span>`); … 2579 `<span class="v">${W} × ${H}</span> cells, cell ${cellLabel}<br/> origin …`; 8426 return `<span class="v">…km</span> coverage`; 4996 .addTo(map).bindTooltip("Source"); 4170 if (meta) meta.textContent = `Reading ${file.name}…`; 3333 throw new Error(`Overpass HTTP ${resp.status} (busy? try again in a minute)`); (key "status.overpass_http" exists at app.js:79 and is used at 3420/4127)
```

**Fix approach.** Add PT+EN STRINGS keys and route each site through t(). Suggested keys: stats.max_e {pt:'E máx: <span class="v">{0}</span>'}, stats.time, stats.max_passes, stats.routes_count ('{0} rota(s):'/'{0} route(s):'), stats.shared, stats.path_e, stats.length, stats.route_tooltip ('rota {0} · E {1} · {2} km'), dem.meta_cells / dem.meta_origin / dem.meta_coverage (thread through formatCellSize/formatCoverage or assemble in the demMeta template), marker.src ('Origem'/'Source'), marker.dst ('Destino'/'Destination'), status.reading_file ('Lendo {0}…'), status.osm_no_ways, and cmap.group_* keys for the 12 COLORCET_GROUPS labels (give each group a labelKey and call t() at option-build time in both selects). In renderResult keep escapeHtml semantics unchanged (values are numeric; keys come from the trusted table). For the marker tooltips: change placeMarker(point,label) at app.js:9785 to take a kind parameter ('src'/'dst') instead of comparing label === "Source" (line 9790), bind t("marker.src")/t("marker.dst"), and pass t("marker.src")/t("marker.dst") as the {0} of status.snap_failed_label at 5600/5605. Replace app.js:3333 with throw new Error(t("status.overpass_http", resp.status)) and 3354 with the new status.osm_no_ways key. Optionally i18n the 'ref {n}' tooltips at 5078/5100/5627 (borderline technical). Bump sw.js VERSION and add a changelog line in all three places.

**Tests to run:** `node test-worker-pool.mjs (sanity: engine untouched)`, `node -e check: every new STRINGS key has both pt and en and matching {n} placeholders (extract the STRINGS object and diff key sets)`, `Manual browser: load a DEM, run a compute with top-N, verify the 3A panel/DEM meta/tooltips render in PT, then toggle EN and recompute`

**Invariants — do not break:** Every new key needs BOTH pt and en with identical {n} placeholder sets; keep escapeHtml() on all user-derived interpolations (err.message, file.name) before innerHTML; do NOT touch energy-worker.js/backend (bit-parity surface); bump sw.js VERSION and move the changelog trio (CHANGELOG.md + index.html <details id=changelog> + sw.js comment) together; the app name 'Simujaules' is deliberate — do not respell it.

*(Fix approach independently re-verified as sound.)*

---

### [low] New round-trip route note reads the LIVE mode select instead of the run's mode — mislabels results if the user changes mode mid-compute

**Where:** `app.js:6668`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** v49 added the top-N disclosure "energia das rotas alternativas: apenas o trecho de ida" (route.round_note) to renderResult, but gates it on the CURRENT value of the #mode select (`document.getElementById("mode")?.value`) rather than the mode the run was actually computed with. The mode select is not disabled during a compute (only the Run button is). Failure scenario: start a round-trip top-N compute, switch the mode select to "a partir da fonte" while it runs → the results render without the outbound-leg-only note even though the field is fwd+bwd and the route energies cover only the outbound leg (the exact confusion the note was added to prevent); conversely a "from" run finished after switching the select to "ida e volta" gets the note wrongly appended. The worker message already flows through a closure where the run's `mode` const is in scope, so the correct value is available at the call site (app.js:5685 renderResult(m)). Note the bundle-restore caller (app.js:9934) is fine as-is because applyMetadataToUI restores the select from the bundle's params first.

**Evidence.**
```
app.js:6665-6670:
    // Round mode: the round FIELD is fwd+bwd, but the A* alternatives are
    // still scored seed→goal only (by design) — say so, or the route
    // energies look inconsistent with the field.
    if ((document.getElementById("mode")?.value || "from") === "round") {
      meta.push(t("route.round_note"));
    }
```

**Fix approach.** Snapshot the run's mode into the rendered result: in the runBtn click closure's computeDone (app.js:5675), set `m.runMode = mode;` before `renderResult(m)` (line 5685); in renderResult's destructuring add `runMode`, and change the gate at line 6668 to `((runMode ?? document.getElementById("mode")?.value) || "from") === "round"` — the DOM fallback keeps the bundle-restore path (app.js:9934, which sets the select via applyMetadataToUI before rendering) working unchanged.

**Tests to run:** `node test-worker-pool.mjs`

**Invariants — do not break:** renderResult must keep working when called from the bundle-restore path (synth object without runMode). The note string stays in the STRINGS table (route.round_note) — never hardcode display text. Style-knob re-renders (rerenderCachedResult) must not recompute or re-run renderResult. Bump sw.js VERSION + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

### [low] Stride edge handling: overlays are stretched past the sampled extent and the impassable scatter wraps right-edge cells to the next row when W/H % stride != 0

**Where:** `app.js:7282`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** overlayCanvasDims uses outW = floor(W/stride), outH = floor(H/stride), so at stride>1 the canvas represents only outW*stride <= W columns (up to stride-1 columns dropped), yet applyEnergyOverlay/applyPassesOverlay/applyImpassableOverlay (and the relief overlay) stretch it across the FULL DEM bounds [[originY - H*dy, originX], [originY, originX + W*dx]] — a cumulative shear of up to stride-1 cells (e.g. ~90 m at the eastern/southern edge of a 30 m, stride-4 DEM), so corridors near the DEM edge visibly misalign with the basemap. Separately, renderImpassableDataURL's scatter index `outIdx = (((r/stride)|0) * outW + ((c/stride)|0)) << 2` (app.js:7427) does not clamp: cells in the last W%stride columns compute column index outW, which WRAPS to the first pixel of the next output row — blocked-water pixels from the right edge paint on the left edge one row down (rows in the last H%stride rows write out of bounds and are silently dropped, which is merely missing data). Failure scenario: >10.5M-cell DEM with W not divisible by the stride and an impassable mask along the eastern edge — red blocked-cell pixels appear along the WESTERN edge of the overlay.

**Evidence.**
```
app.js:7282: `return { stride, outW: Math.max(1, Math.floor(W / stride)), outH: Math.max(1, Math.floor(H / stride)) };`
app.js:7472: `const bounds = [[originY - H * dy, originX], [originY, originX + W * dx]];` (same at 7448, 7483)
app.js:7427: `const outIdx = (i) => { const r = (i / W) | 0, c = i - r * W; return (((r / stride) | 0) * outW + ((c / stride) | 0)) << 2; };`
```

**Fix approach.** (a) In renderImpassableDataURL's outIdx (app.js:7427), clamp both indices: `const or = Math.min(outH - 1, (r / stride) | 0), oc = Math.min(outW - 1, (c / stride) | 0); return (or * outW + oc) << 2;` (outH is already available from the overlayCanvasDims destructuring). (b) For the stretch: in applyEnergyOverlay, applyPassesOverlay, applyImpassableOverlay and the relief overlay creation, compute `const { stride, outW, outH } = overlayCanvasDims(W, H);` and set bounds to the sampled extent: `[[originY - outH * stride * dy, originX], [originY, originX + outW * stride * dx]]` — identical to today when stride=1 or when W,H divide evenly. This also keeps the on-screen render consistent with the fixed .pgw of the rendered-PNG export (which describes exactly the outW x outH strided grid).

**Tests to run:** `Browser with a DEM whose W,H are not multiples of the stride (temporarily lower RELIEF_MAX_CANVAS_PX to force stride>1 on a small DEM): verify blocked-water pixels no longer appear on the wrong (left) edge and that the energy overlay's right/bottom edge aligns with the DEM rectangle (state.demRect)`, `Verify stride=1 DEMs render byte-identically (bounds unchanged)`

**Invariants — do not break:** stride=1 behaviour must be byte-identical; overlayCanvasDims remains the shared single source of stride; do not touch renderFieldToDataURL's sampling loop (it is already wrap-free); keep the exportRenderedImages world file consistent with whatever bounds convention is chosen; sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

## AJS-5 — app.js pipeline — stage 5: colormap, GeoTIFF/PNG export

**Files:** `app.js (lines ~8000-9500)`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [high] Exported rendered-PNG world file ignores the canvas stride-downsample — mis-georeferenced by the stride factor on huge DEMs

**Where:** `app.js:9419`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** exportRenderedImages() zips state.energyDataUrl / state.passesDataUrl PNGs with an ESRI world file (.pgw) built from the DEM's native per-cell size: pixel size dx/-dy, top-left pixel centre originX+dx/2 / originY-dy/2. But those dataURLs are produced by renderFieldToDataURL() / renderDualPassesToDataURL(), which stride-downsample the canvas via overlayCanvasDims(W, H) whenever W*H > 10,485,760 cells (RELIEF_MAX_CANVAS_PX): stride = ceil(sqrt(N/10485760)), canvas = floor(W/stride) x floor(H/stride). On the documented flagship 135M-cell "Sampa Sítio Urbano" DEM the stride is 4, so the exported PNG has 1/4 the pixels per axis, but the .pgw still declares one-DEM-cell pixels. Dropped into QGIS, the raster silently covers only 1/16 of the true footprint, anchored at the top-left corner — plainly wrong georeferencing. The code even documents this exact failure mode for the relief layer (comment above exportRenderedImages: relief is 'stride-downsampled on huge DEMs, so the DEM's dx/dy world file would be wrong for it' — and excludes relief for that reason) but misses that energy/passes go through the same overlayCanvasDims path. Failure scenario: load a >10.5M-cell DEM (any FABDEM viewport bigger than ~3300x3300, or the 135M-cell GeoTIFF), run a compute, click the 'export rendered' button, open the zip in QGIS: the PNG lands at 1/stride scale, misaligned with everything.

**Evidence.**
```
app.js:9417-9420:
    const { dx, dy, originX, originY, isGeographic } = state.dem;
    // World file: pixel size, rotation terms, centre of the top-left pixel.
    const worldFile =
      `${dx}\n0\n0\n${-dy}\n${originX + dx / 2}\n${originY - dy / 2}\n`;
while renderFieldToDataURL (app.js:7017) does:
    const { stride, outW, outH } = overlayCanvasDims(W, H);
and overlayCanvasDims (app.js:7278-7283): if (N > RELIEF_MAX_CANVAS_PX) stride = Math.ceil(Math.sqrt(N / RELIEF_MAX_CANVAS_PX));
```

**Fix approach.** In exportRenderedImages() (app.js ~9402-9449), compute the same stride the renderer used: `const { stride } = overlayCanvasDims(state.dem.W, state.dem.H);` then build the world file from the strided pixel size: `const sdx = dx * stride, sdy = dy * stride;` and write `${sdx}\n0\n0\n${-sdy}\n${originX + sdx / 2}\n${originY - sdy / 2}\n`. Both energy_rendered and passes_rendered PNGs come from the same W/H so one world file string still serves both. Do NOT duplicate the stride formula inline — call overlayCanvasDims so exporter and renderer can never drift. Because this changes a served file (app.js), bump sw.js VERSION and add the changelog line to all three changelog locations (CHANGELOG.md, the <details id="changelog"> in index.html, the sw.js version-history comment).

**Tests to run:** `Browser smoke test with the service worker bypassed: load a small DEM (<10.5M cells), compute, export rendered PNGs, confirm the .pgw is unchanged (stride=1); then synthetically lower RELIEF_MAX_CANVAS_PX (or load a >10.5M-cell DEM), export again, and verify with gdalinfo / QGIS that the PNG+.pgw covers the full DEM extent`, `node test-worker-pool.mjs (regression guard — must stay green, no engine files touched)`

**Invariants — do not break:** overlayCanvasDims must remain the single source of stride for renderer AND exporter (no drift); do not change RELIEF_MAX_CANVAS_PX or the render pipeline itself; stride=1 exports must stay byte-identical; keep the legacy 'simujoules-rendered-' filename prefix (deliberate legacy spelling); sw.js VERSION discipline + changelog trio; no new hardcoded UI strings (use STRINGS/t()).

*(Fix approach independently re-verified as sound.)*

---

### [medium] Exported GeoTIFFs from FABDEM-loaded DEMs lack GTModelTypeGeoKey — GDAL/QGIS reads an unknown engineering CRS instead of EPSG:4326

**Where:** `app.js:8625`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** tiffMetadataForDem() forwards dem.geoKeys verbatim, else falls back to only `md.GeographicTypeGeoKey = 4326`. The FABDEM viewport loader wraps its mosaic with the same minimal key set (app.js:2387-2396, only GeographicTypeGeoKey) — so a FABDEM-loaded DEM's dem.geoKeys is {GeographicTypeGeoKey: 4326} and every export (energy.tif, passes.tif, network.tif, impassable.tif, dem.tif via exportDemTif, exportMaskTif) ships a GeoKeyDirectory without GTModelTypeGeoKey. Verified empirically with geotiff.js 3.0.5 + GDAL: a file written with only GeographicTypeGeoKey:4326 is reported by gdalinfo as `ENGCRS["unnamed", EDATUM["Unknown engineering datum"]...]` (unknown/non-earth CRS); adding GTModelTypeGeoKey:2 makes the same file read as GEOGCRS WGS 84 / EPSG:4326. So the app's documented claim that exported rasters 'drop straight into QGIS' georeferenced fails for the entire FABDEM flow: QGIS opens the layer with an unknown CRS and it cannot be overlaid on OSM/other layers without manually assigning EPSG:4326. User-uploaded DEMs with complete source GeoKeys are unaffected (their GTModelTypeGeoKey is forwarded). Failure scenario: load a FABDEM viewport, compute, download the bundle, open energy.tif in QGIS — layer has unknown CRS and won't align with a basemap.

**Evidence.**
```
app.js:8623-8627:
  if (geoKeys && Object.keys(geoKeys).length > 0) {
    Object.assign(md, geoKeys);
  } else if (isGeographic) {
    md.GeographicTypeGeoKey = 4326;
  }
and FABDEM mosaic app.js:2387-2396 ends with only `GeographicTypeGeoKey: 4326`. gdalinfo on a file written this way: `Coordinate System is: ENGCRS["unnamed", EDATUM["Unknown engineering datum"]`; with GTModelTypeGeoKey:2 added: `GEOGCRS["WGS 84" ...]`.
```

**Fix approach.** In tiffMetadataForDem() (app.js ~8600-8628), after the geoKeys assignment block, backfill the mandatory keys when absent: `if (md.ProjectedCSTypeGeoKey && md.GTModelTypeGeoKey == null) md.GTModelTypeGeoKey = 1; else if (md.GeographicTypeGeoKey && md.GTModelTypeGeoKey == null) md.GTModelTypeGeoKey = 2; if (md.GTModelTypeGeoKey != null && md.GTRasterTypeGeoKey == null) md.GTRasterTypeGeoKey = 1;` (only fill when missing — never override a source-provided GTRasterTypeGeoKey, e.g. PixelIsPoint=2). Also add `GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1` to the FABDEM mosaic tiffMd at app.js:2387-2396 so freshly loaded FABDEM DEMs carry a complete key set (this also lets loadDemFromArrayBuffer's modelType check take the declared path instead of the magnitude heuristic). Bump sw.js VERSION + changelog trio.

**Tests to run:** `Node structural check against the CDN geotiff.js bundle: write a Float32 tif via GeoTIFF.writeArrayBuffer with the new metadata and confirm gdalinfo reports EPSG:4326`, `Browser: load a FABDEM viewport, download a bundle, open energy.tif in QGIS/gdalinfo and confirm WGS 84`, `Re-import the bundle in the app (loadBundleFile) and confirm rasters restore identically (readRasterFromGeoTIFF path unchanged)`

**Invariants — do not break:** geoKeys from source DEMs must keep being forwarded verbatim (only backfill missing keys, never overwrite); projected-DEM exports must not gain a bogus 4326 key; bundle round-trip (readRasterFromGeoTIFF strict-size check) must be unaffected; sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Rendered-PNG export is blocked after a graph-mode run — guard checks state.lastResult but graph runs only set state.lastGraphResult

**Where:** `app.js:9404`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** exportRenderedImages() bails with the 'nothing rendered' error when state.lastResult is null. Graph-mode ("follow the vectors") computes never set state.lastResult — they set state.lastGraphResult (app.js:6396) and render through renderGraphOverlay(), which DOES populate state.energyDataUrl (interpolated energy raster, app.js:4758) and often state.passesDataUrl (rasterised network/terrain passes, app.js:4812/4830/4853). So in a fresh session: load DEM + network, run a graph-mode compute (energy raster visibly on the map), click the export-rendered button — the app falsely reports t("status.nothing_rendered") and exports nothing. downloadBundle() next to it handles this correctly with `!state.lastResult && !state.lastGraphResult` (app.js:9457). Conversely, if a raster run preceded the graph run, the stale non-null lastResult lets the export proceed and it correctly exports the current graph-mode dataURLs — proving the guard is simply wrong.

**Evidence.**
```
app.js:9404-9407:
    if (!state.dem || !state.lastResult) {
      status.textContent = t("status.nothing_rendered");
      return;
    }
vs downloadBundle app.js:9457: `if (!state.lastResult && !state.lastGraphResult) {`. Graph completion app.js:6396 sets only state.lastGraphResult.
```

**Fix approach.** Change the guard in exportRenderedImages() to mirror downloadBundle: `if (!state.dem || (!state.lastResult && !state.lastGraphResult)) { status.textContent = t("status.nothing_rendered"); return; }`. The rest of the function already exports whatever dataURLs exist (graph-mode vector passes have no dataURL and correctly fall through to t("status.no_layers_export")). Bump sw.js VERSION + changelog trio.

**Tests to run:** `Browser: fresh session, load DEM + .gpkg network, enable graph mode, compute, click export-rendered — a zip with energy_rendered.png (+ .pgw/.prj) must download`, `Repeat in raster mode to confirm no regression`

**Invariants — do not break:** Keep the world-file logic in sync with the stride fix (the graph energy raster uses the same overlayCanvasDims stride); all status messages via STRINGS/t(); sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [low] buildMetadata/applyMetadataToUI reference the nonexistent element id #ref-source (renamed to #ref-sampling) — exported bundles always record refSource:"click" and the restore is a silent no-op

**Where:** `app.js:9196`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** index.html contains only <select id="ref-sampling"> (line 1096, values random/sobol/halton/census); there is no #ref-source element. Three app.js sites still use the dead id: (1) buildMetadata line 9196 `refSource: document.getElementById("ref-source")?.value || "click"` — getElementById returns null, so EVERY exported bundle records refSource:"click" regardless of the actual sampling mode (wrong provenance; e.g. a Sobol- or census-sampled density run is recorded as hand-clicked); (2) applyMetadataToUI line 9690 `set("ref-source", p.refSource)` — a no-op, so the sampling mode never restores from params (census/census-density.mjs deliberately writes refSource:"census" at census-density.mjs:256 'so the app's bundle restore re-fills the UI knobs' — that restore silently does nothing); (3) the map-click handler line 4984 `const densityClick = (document.getElementById("ref-source")?.value || "click") === "click"` is always true, leaving the t("status.ref_random_mode") else-branch dead. For v3 bundles the value happens to round-trip anyway because "ref-sampling" is in PERSIST_IDS→md.config, but the params field is wrong for all consumers and pre-config bundles.

**Evidence.**
```
index.html 1096: `<select id="ref-sampling">`; app.js 9196: `refSource:     document.getElementById("ref-source")?.value || "click",`; app.js 9690: `set("ref-source", p.refSource);`; app.js 4984: `const densityClick = (document.getElementById("ref-source")?.value || "click") === "click";`
```

**Fix approach.** (a) buildMetadata: change to `refSource: document.getElementById("ref-sampling")?.value || "random"`. (b) applyMetadataToUI: replace `set("ref-source", p.refSource)` with a guarded restore that only accepts current select values: `if (["random","sobol","halton","census"].includes(p.refSource)) set("ref-sampling", p.refSource);` (legacy values "click"/"random" from old bundles: "random" maps through, "click" is ignored). (c) In the density click branch at app.js 4983-4990, delete the dead #ref-source gate and unconditionally call addRefPoint([r, c]) — this preserves today's actual behaviour (clicks always add refs) while removing the dead else-branch; leave the STRINGS "status.ref_random_mode" entry in place (harmless) or remove it from both languages together.

**Tests to run:** `Manual browser: set sampling to Sobol, place refs, run density, export — metadata.jsonld params.refSource must read "sobol"; re-import and confirm the #ref-sampling select restores; click the map in density mode and confirm a ref point is still added`, `node census/test-census-density.mjs (needs npm install in census/) — census bundle metadata unchanged on the writer side`

**Invariants — do not break:** Do NOT make map clicks stop adding ref points in density mode (none of ref-sampling's values equal "click", so a naive id swap at line 4984 would silently disable click placement — that is the trap). census/census-density.mjs's refSource:"census" writer stays as-is. If STRINGS entries are removed, remove pt and en together. Bump sw.js VERSION + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

### [low] Exported bundles embed the user's backend/orchestrator URLs, and importing a bundle silently repoints the session's compute source and backend URL to bundle-supplied values

**Where:** `app.js:9291`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** buildMetadata embeds collectConfig() wholesale (app.js 9291), and PERSIST_IDS includes "backend-url", "orchestrator-url", "cloud-keep-warm" (app.js 762); collectConfig also records computeSource. Two consequences: (1) LEAK — every shared bundle carries the exporter's backend/orchestrator URLs (possibly private LAN hostnames; the cloud-token itself is safe — it lives in sessionStorage, not in PERSIST_IDS); (2) INJECTION — applyMetadataToUI calls applyConfig(md.config, {persist:false}) which writes those params into the live inputs and selects the computeSource radio (app.js 897-913), so a crafted bundle can set computeSource:"localhost" + backend-url:"https://attacker.example" and the victim's next Compute POSTs their DEM grid to the attacker and renders attacker-forged energy fields — with no user-visible prompt beyond the (persisted-looking) URL field content. persist:false keeps it out of localStorage, but the session is fully repointed.

**Evidence.**
```
app.js 762: `"backend-url", "orchestrator-url", "cloud-keep-warm", "n-routes", ...` in PERSIST_IDS; app.js 9291: `config: collectConfig(),`; app.js 9643: `if (md.config) { try { applyConfig(md.config, { persist: false }); } ...` — applyConfig's PERSIST_IDS loop sets el.value for every id present, and lines 908-913 re-select the compute-source radio.
```

**Fix approach.** Treat connection settings as non-portable: (a) give collectConfig an options flag, e.g. collectConfig({ forBundle: true }) used by buildMetadata only, that deletes params["backend-url"], params["orchestrator-url"], params["cloud-keep-warm"] and omits computeSource; (b) defensively, in applyConfig skip those three ids and the computeSource radio restore when opts.persist === false (bundle path), so even old/crafted bundles cannot repoint the session. Keep the explicit Group-0 config export/import (persist:true) carrying them — that flow is user-initiated for exactly this purpose.

**Tests to run:** `Manual browser: export a bundle and confirm metadata.jsonld config.params has no backend-url/orchestrator-url/cloud-keep-warm and no computeSource; import a bundle whose config sets backend-url and confirm the input and radio are untouched; export/import a Group-0 config.json and confirm those fields still round-trip there`

**Invariants — do not break:** Do not break the Group-0 config export/import (setupConfigButtons) — persist:true keeps full fidelity including connection settings. cloud-token must stay in sessionStorage only, never in config or bundles. No backend auth is to be added (house rule). Bump sw.js VERSION + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

### [low] Graph-mode bundle exported after an earlier grid run writes metadata.jsonld that claims energy.tif/passes.tif/routes.geojson files the zip omits, plus stats from the stale grid result

**Where:** `app.js:9470`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** downloadBundle (app.js 9467-9470) sets graphMode = !!state.lastGraphResult but still calls buildMetadata(state.lastResult, true). A graph compute sets state.lastGraphResult (app.js 6396) WITHOUT clearing state.lastResult (only renderResult clears the graph result, app.js 6603 — the reverse never happens). So after a grid compute followed by a graph compute in the same session, the export takes the graphMode branch: the zip writers skip energy.tif/passes.tif/routes.geojson/path.geojson (all gated `&& !graphMode`, app.js 9481-9528), but buildMetadata's md.outputs descriptors for those files are gated only on result.energy/result.passes/result.routes (app.js 9327-9377) — from the STALE grid result — so metadata.jsonld claims files that are not in the archive, and md.stats/elapsedMs describe the old grid run, not the exported graph run. buildMetadata's own comment for the alt rasters states the intended invariant: 'gate the descriptors so the metadata never claims a file the zip omits' (app.js 9344) — the base descriptors violate it. The in-app reader ignores md.outputs so import doesn't crash, but any external consumer (QGIS scripts, provenance tooling) reading the JSON-LD gets phantom file references and wrong stats.

**Evidence.**
```
app.js 9467-9470: `const graphMode = !!state.lastGraphResult;\n    const r = state.lastResult || {};\n    const dem = state.dem;\n    const md = buildMetadata(state.lastResult, true);` vs app.js 9481: `if (r.energy && !graphMode) { zip.file("energy.tif", ...` while app.js 9327: `energy: result.energy ? { format: "GeoTIFF", ..., file: "energy.tif" } : null` has no graphMode gate.
```

**Fix approach.** In downloadBundle change the buildMetadata call to `const md = buildMetadata(graphMode ? null : state.lastResult, true);` — buildMetadata already handles a null result (withOutputs && result → no md.outputs; stats fields fall to null via result?.), and the existing graphMode branch right below already does `md.outputs = md.outputs || {}` before adding the graphEdges descriptor. Optionally set `md.elapsedMs = state.lastGraphResult.result?.elapsedMs ?? null` in the graphMode branch so graph bundles carry their own timing.

**Tests to run:** `Manual browser: run a grid compute, then a graph compute ('seguir os vetores'), export a bundle, unzip and confirm metadata.jsonld's outputs lists only graphEdges/network/bridges descriptors matching the actual zip members`, `node test-worker-pool.mjs (regression)`

**Invariants — do not break:** Keep schemaVersion 3 and all existing property names — external readers depend on them. The @vocab IRI stays on the legacy telhas.pedalhidrografi.co/simujoules/ path. Grid-mode (non-graph) exports must be byte-identical in structure to before. Bump sw.js VERSION + changelog trio if shipped.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: Don't gate the whole md.outputs block on `result`; only gate the truly result-dependent entries. Restructure buildMetadata (app.js ~9321-9383) as:
```
if (withOutputs) {
  md.outputs = {
    network: state.networkMask ? { format: "GeoTIFF", type: "Uint8", shape: [dem.H, dem.W], file: "network.tif" } : null,
    impassable: state.impassable ? { format: "GeoTIFF", type: "Uint8", shape: [dem.H, dem.W], file: "impassable.tif" } : null,
    bridges: (state.bridges && state.bridges.length) ? { format: "GeoJSON", file: "bridges.geojson" } : null,
  };
  if (result) {
    md.outputs.energy = ...; md.outputs.passes = ...; md.outputs.energyUnconstrained = ...;
    md.outputs.energyDifference = ...; md.outputs.passesUnconstrained = ...;
    md.outputs.routes = ...; md.outputs.path = ...; md.outputs.pathAlt = ...;
  }
}
```
Then downloadBundle's `const md = buildMetadata(graphMode ? null : state.lastResult, true);` becomes correct for BOTH the reported stale-result case and the pre-existing graph-only-session case, without losing the network/impassable/bridges descriptors that are unconditionally present in graph-mode zips. Keep the energyUnconstrained/energyDifference/passesUnconstrained entries' existing `!state.lastGraphResult` sub-guards (9345-9353) as-is inside the `if (result)` branch — they're redundant once the outer call passes null for graphMode, but harmless, and protect the separate `buildMetadata` call site(s) if any exist elsewhere (check for other callers before removing them). Add a test case exporting a graph-mode bundle WITH a loaded network (the common case) and confirm metadata.jsonld's outputs.network/impassable/bridges keys are present and match actual zip members, in addition to the originally-specified graphEdges-only check. This keeps schemaVersion 3 / property names / the legacy @vocab IRI intact and does not touch grid-mode (non-graph) export structure, so the stated invariants still hold.

---

### [low] energy.tif is written with +Infinity for unreachable cells and no GDAL_NODATA — GDAL/QGIS statistics become inf/nan and default styling breaks

**Where:** `app.js:9482`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** The energy field stores +Infinity in cells unreachable from the source/refs (worker initialises E to Infinity; the compare difference field also sets Infinity where either scenario is non-finite, app.js:6374). downloadBundle writes these arrays verbatim into energy.tif / energy_unconstrained.tif / energy_difference.tif with no nodata tag. Verified with GDAL: gdalinfo -stats on such a file reports `Minimum=0.000, Maximum=inf, Mean=nan, StdDev=nan` — QGIS's default min/max stretch on the band is broken (renders washed out / single-colour) and any raster-calculator use propagates inf. Since the bundle's stated purpose is 'drops straight into QGIS', this is a real usability defect, though the pixel data itself is intact. Verified fix path: geotiff.js 3.0.5 writes a GDAL_NODATA ASCII tag and GDAL accepts 'inf' — with GDAL_NODATA='inf' gdalinfo reports 'NoData Value=inf' and clean finite statistics.

**Evidence.**
```
app.js:9481-9495 writes r.energy / energyAlt.unconstrained / energyAlt.difference via writeRasterAsGeoTIFF(..., "float32") with no nodata metadata. gdalinfo -stats on a test file with Infinity cells: `Minimum=0.000, Maximum=inf, Mean=nan, StdDev=nan`; with GDAL_NODATA 'inf': `NoData Value=inf` and correct stats.
```

**Fix approach.** Using the extraMd parameter added to writeRasterAsGeoTIFF (see the exportDemTif nodata finding — or add it here if that finding is fixed separately), pass `{ GDAL_NODATA: "inf" }` for the three float32 energy rasters in downloadBundle (energy.tif at app.js:9482, energy_unconstrained.tif at 9491, energy_difference.tif at 9494). Leave passes*.tif untouched (0 there means 'no passes', a legitimate value, not nodata) and leave the pixel values as Infinity (the bundle reload path readRasterFromGeoTIFF ignores the tag, so in-app semantics are unchanged).

**Tests to run:** `gdalinfo -stats on an exported energy.tif: NoData Value=inf, finite Min/Max/Mean`, `Browser: export a bundle after a from-mode compute, re-import it, confirm the energy overlay renders identically (unreachable cells still transparent)`

**Invariants — do not break:** Bundle reload must keep reconstructing Infinity in the arrays (do NOT rewrite pixel values to a finite sentinel); passes.tif f64 wire format unchanged; network.tif/impassable.tif unchanged; sw.js VERSION discipline + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [info] colormap() falls back to COLORMAPS.viridis, which does not exist — the defensive fallback would crash instead of defending

**Where:** `app.js:8556`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** colormap(t) does `const anchors = COLORMAPS[activeColormap] || COLORMAPS.viridis;` but the COLORMAPS table (app.js:8435-8505) contains only CET_* maps and cmo_phase — there is no 'viridis' key. If activeColormap ever held an invalid name, anchors would be undefined and `anchors.length` throws a TypeError inside the per-pixel render loop, killing the whole render. Today all writers of activeColormap are guarded (`if (COLORMAPS[saved[id]])` at app.js:820 and :904, and the select only contains valid keys), so the branch is dead — but it is a booby trap for any future code path (e.g. a config import adding an unguarded assignment) and defeats its own stated purpose as a fallback.

**Evidence.**
```
app.js:8555-8556:
function colormap(t) {
  const anchors = COLORMAPS[activeColormap] || COLORMAPS.viridis;
(COLORMAPS at 8435-8505 has no `viridis` entry.)
```

**Fix approach.** Change the fallback to the app's actual default map: `const anchors = COLORMAPS[activeColormap] || COLORMAPS.cmo_phase;` (cmo_phase is the declared default at app.js:8523). One-line change.

**Tests to run:** `Browser smoke: compute and cycle a few colormaps via the selector + 'Atualizar estilo' — renders unchanged`, `Console check: temporarily set activeColormap to a bogus string and call rerenderCachedResult() — must render with cmo_phase instead of throwing`

**Invariants — do not break:** Default colormap stays cmo_phase; no behaviour change for valid selections; if shipped with other fixes, fold into the same sw.js VERSION bump + changelog trio (a lone internal fallback fix does not need its own user-facing changelog line).

*(Fix approach independently re-verified as sound.)*

---

### [info] Exported routes.geojson/path.geojson in "até" mode: LineString coordinate order (src→dst) is opposite the travel direction the energy now scores (dst→src), with no orientation property or doc

**Where:** `app.js:9126`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** With the v49 fix, mode "até" (to) top-N route energies correctly measure travel destination→reference — but the path index arrays (and hence the exported GeoJSON LineStrings built by routesFCFromList/pathFCFromIndices) are still written in A*-search order, reference-first (src marker → dst marker). The features carry rank/energy/length_m/shared_cells but no direction property, so an external consumer (QGIS, scripts) naturally reads the geometry in coordinate order and attributes the energy to the src→dst traversal — the wrong direction, off by the full asymmetric climb/descent difference. This convention actually predates v49 for the single best path (the "to" field's pathEnergy was always reverse-scored), so this is a disclosure gap rather than a regression: v49 made routes consistent with the path convention but neither documents it. The in-app rendering is unaffected (undirected polylines, no arrows).

**Evidence.**
```
app.js:9126-9138 (routesFCFromList):
      geometry: {
        type: "LineString",
        coordinates: r.path.map((idx) => pixelToLonLat(idx, dem)),
      },
      properties: {
        rank: i + 1,
        energy: r.energy,
energy-worker.js:1578-1581: `// Mode "to" fields/paths measure travel dst→seed (dijkstra reverse:true) — score the routes in that same direction.`
```

**Fix approach.** Add a `direction` property to every exported route/path feature: in routesFCFromList and pathFCFromIndices (app.js ~9114-9140), accept the run mode (available from the bundle metadata params already serialised alongside) and set `direction: mode === "to" ? "destination→source (energy direction; coordinates written source→destination)" : "source→destination"` — or more simply a boolean `travel_opposes_coordinate_order: mode === "to"`. Also add one sentence to the help modal's bundle section (STRINGS key help.p.bundle, both pt and en) noting that in "até" mode route energies score the destination→reference direction. Do not reverse the coordinate arrays (bundle re-import via routesFromFC/pathFromFC and the compare-route rendering consume them order-insensitively, but reversing would churn every existing exported bundle's semantics).

**Tests to run:** `node test-worker-pool.mjs`

**Invariants — do not break:** Bundle import (routesFromFC/pathFromFC) must keep accepting old bundles without the new property. The metadata JSON-LD @vocab IRI must stay on the legacy telhas.pedalhidrografi.co/simujoules/ path. All new UI text through STRINGS/t() in both PT and EN. Bump sw.js VERSION + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

## AJS-6 — app.js pipeline — stage 6: bundle export/import

**Files:** `app.js (lines ~9500-9700)`

**Run this stage only after the previous `AJS-*` stage has landed on disk** —
they share `app.js`. Grep for the current line before editing; the app has
moved since this review (v50 landed an unrelated icon change first).

### [high] Bundle binary replay gates on H×W only — a same-size DEM with a different extent silently renders the bundle's rasters and routes at the wrong geography

**Where:** `app.js:9651`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** applyMetadataToUI (app.js ~9650) gates binary replay (energy/passes/network/impassable rasters, routes/path/path_alt GeoJSON→cell-index conversion, src/dst/ref marker placement) on state.dem.H === md.dem.H && state.dem.W === md.dem.W only. buildMetadata records originX/originY/dx/dy/isGeographic in md.dem (app.js 9296-9304) but the reader never compares them. Many DEM products share dimensions (e.g. all 1-degree SRTM/FABDEM tiles are the same pixel size), so importing a bundle computed on tile A while tile B is loaded passes the gate: the energy/passes overlays render tile-A data stretched over tile B's bounds, and lonLatToPixel (app.js 9081, whose own comment says it is 'Only safe when the DEM matches the one the coords were written against') converts routes/path coordinates through the wrong geotransform into out-of-range or wrong cell indices. Everything displays without any warning — silently wrong results. The pendingBundle replay gate in loadDemFromArrayBuffer (app.js 2652-2662) has the same dims-only check.

**Evidence.**
```
app.js 9651-9654: `const demDimsMatch =\n    state.dem && Number.isFinite(bundleH) && Number.isFinite(bundleW)\n      ? state.dem.H === bundleH && state.dem.W === bundleW\n      : null;` — no originX/originY/dx/dy comparison; app.js 9077-9078 (lonLatToPixel comment): "Only safe when the DEM matches the one the coords were written against (callers gate on demDimsMatch === true)".
```

**Fix approach.** Add an extent check next to the dims check in applyMetadataToUI: compute `demExtentMatch` from md.dem vs state.dem — |originX−dem.originX| ≤ 0.5·dem.dx, |originY−dem.originY| ≤ 0.5·dem.dy, |dx−dem.dx| ≤ 1e-6·dem.dx, |dy−dem.dy| ≤ 1e-6·dem.dy (return null=unknown when md.dem lacks these fields, preserving old-bundle behaviour). Extract a shared helper (e.g. bundleDemMatch(mdDem, dem) returning true/false/null combining dims+extent) and use it (a) for the demDimsMatch gates at app.js 9655/9665/9797/9803/9814/9829/9854/9877/9901, (b) for the pendingBundle replay gate in loadDemFromArrayBuffer (app.js 2652-2662). On dims-match-but-extent-mismatch: skip binary replay, keep params applied, hold state.pendingBundle, and show a new status message — add STRINGS keys (pt + en), e.g. "status.bundle_dem_extent_mismatch", alongside the existing "status.bundle_dem_mismatch" at app.js ~119.

**Tests to run:** `Manual browser: export a bundle on one DEM, re-import on the same DEM (must fully restore), then import on a different DEM with identical H×W (must warn and skip binaries, and replay later when the right DEM loads)`, `node test-worker-pool.mjs (regression, must stay green)`

**Invariants — do not break:** Do not reject the same DEM reloaded (JSON round-trips doubles exactly; the half-pixel tolerance is safe). Keep the pendingBundle flow working (bundle first, DEM later). New user-visible text goes through the STRINGS/t() table in both pt and en — never hardcoded. escapeHtml before any innerHTML. No engine files touched. If shipped, bump sw.js VERSION and move the changelog trio (CHANGELOG.md + index.html <details id="changelog"> + sw.js comment) together.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Bundle export materialises every raster copy plus the zip simultaneously in memory (~4–8 GB for a 135 M-cell compare run)

**Where:** `app.js:9541`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** The 'Baixar bundle' handler writes each output raster through writeRasterAsGeoTIFF (a full ArrayBuffer copy per raster) into JSZip, then `zip.generateAsync({ type: "blob" })` builds the archive. For a 135 M-cell compare run with passes, the GeoTIFF copies alone are ~4 GB held at once (energy f32 540 MB + passes f64 1.08 GB + energy_unconstrained 540 MB + energy_difference 540 MB + passes_unconstrained 1.08 GB + network/impassable u8 135 MB each), all pinned inside JSZip while generateAsync additionally accumulates the output; without streamFiles, JSZip buffers per-file data a second time during generation. state.lastResult's ~3.8 GB is also still retained. Failure scenario: user finishes a minutes-long 135 M-cell compare compute and clicks 'Baixar bundle' — the tab's memory spikes past ~8–12 GB and is OOM-killed on 8–16 GB machines, losing the un-exported result; a graph-mode bundle additionally JSON.stringify-s a per-edge GeoJSON that can reach hundreds of MB as a single string.

**Evidence.**
```
app.js:9482-9497: `zip.file("energy.tif", new Uint8Array(writeRasterAsGeoTIFF(r.energy, dem, "float32"))); … zip.file("passes.tif", new Uint8Array(writeRasterAsGeoTIFF(r.passes, dem, "float64"))); … zip.file("passes_unconstrained.tif", new Uint8Array(writeRasterAsGeoTIFF(r.passesAlt.unconstrained, dem, "float64")));` and 9541: `const blob = await zip.generateAsync({ type: "blob" });`
```

**Fix approach.** Minimal, safe step: pass `{ type: "blob", streamFiles: true }` to zip.generateAsync in the bundle download handler (app.js:9541) so JSZip streams each entry into the output blob (Chrome blobs can be disk-backed) instead of double-buffering, and add a comment noting the GeoTIFF source copies are still held until generation completes. Do not attempt a custom streaming-zip rewrite in this fix.

**Tests to run:** `browser smoke: export a bundle from a small compute, re-import it via 'Carregar bundle' and confirm rasters/route/params round-trip (STORE'd zip entries must stay readable by JSZip.loadAsync and by QGIS unzip)`

**Invariants — do not break:** Bundle format/content must stay byte-compatible for the reader (loadBundleFile) — streamFiles changes zip internals (data descriptors) but JSZip and standard unzip tools read them; keep the @vocab legacy IRI untouched; sw.js VERSION + changelog trio on ship.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: Drop the `streamFiles: true` line — it is a no-op for peak memory in this path (see explanation) and should not be presented as the fix. To genuinely bound memory you need to avoid ever materializing the whole zip in one JS buffer via `generateAsync({type:"blob"})`'s `accumulate()`, e.g.:
(a) Real fix (bigger scope than "trivial"): use `zip.generateInternalStream({ type: "uint8array", streamFiles: true })` and listen to its `"data"` events, writing each chunk immediately to a `FileSystemWritableFileStream` obtained via `showSaveFilePicker()` (File System Access API), so bytes go to disk as generated rather than into one in-memory Blob. Needs a fallback to the current `generateAsync`+Blob flow for browsers without FSA support (Firefox/Safari), ideally gated by an estimated-size warning.
(b) If a JS-only mitigation is wanted without the FSA rewrite, at least stop holding both the raw `state.lastResult` typed arrays and the GeoTIFF-encoded copies simultaneously is not achievable without losing UI redisplay ability, so there is no cheap partial win here — don't claim one.
(c) Do not "fix" this by adding `compression: "DEFLATE"` — that increases memory (zlib work buffers) and CPU time without addressing the accumulate/concat duplication; STORE (the current default) is already the right choice for this problem, just insufficient alone.
Keep the "invariants" the original spec listed (bundle format must stay byte-compatible with loadBundleFile/JSZip.loadAsync and standard unzip tools; @vocab IRI untouched; sw.js VERSION + changelog trio on ship) — a File System Access rewrite must still produce a standard, JSZip-and-unzip-readable .zip (data descriptors via `streamFiles: true` are standard and fine to use inside that rewrite, just not sufficient on their own as originally proposed). If the team decides a full streaming rewrite is out of scope for now, this finding should be marked as a documented won't-fix/info item rather than shipped with a change that doesn't fix the stated problem.

---

### [medium] Importing a graph-mode bundle silently drops the exported result and leaves a misleading UI state (graph checkbox on, next Compute silently runs the raster engine) with zero in-app disclosure

**Where:** `app.js:9562`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** downloadBundle writes graph_edges.geojson plus md.outputs.graphEdges for 'seguir os vetores' runs (app.js 9471-9474, 9536-9539), but loadBundleFile never reads graph_edges.geojson (it reads energy/passes/alt tifs, network, impassable, bridges, routes, path, path_alt — nothing else) and applyMetadataToUI never touches state.lastGraphResult. Additionally the network vector LINES (state.networkLines) are not in the bundle (only the rasterised network.tif mask), so after import graphModeActive() (app.js 4462-4464, requires networkLines) is false even though md.config restored vec-graph-mode checked. Net effect for a user who receives a graph bundle: (1) the exported result never appears; (2) the status line says only 'Bundle parameters loaded. Click Compute to reproduce.'; (3) clicking Compute silently dispatches the RASTER engine (dispatchCompute at app.js 6490-6503 falls through when networkLines is empty) — a different engine than the bundle's metadata (network.graphMode:true, outputs.graphEdges) declares, with no warning. The limitation itself is documented in CHANGELOG (v15: 'graph_edges.geojson is still not restored'; v48: 'graph results never do [round-trip]') but there is no import-time disclosure in the app.

**Evidence.**
```
loadBundleFile app.js 9566-9615 reads metadata/energy/passes/alt/network/impassable/bridges/routes/path/path_alt — `grep graph_edges` in the reader: no hits; app.js 6492: `if (graphModeActive() && state.networkLines && state.networkLines.length) { startGraphCompute(); } else if (...` — silent raster fallback; CHANGELOG.md 755: "(Graph-mode `graph_edges.geojson` is still not restored — it needs the full graph object, not just edge geometry.)"
```

**Fix approach.** Minimal, no engine work: in applyMetadataToUI, after the config/params restore, detect a graph bundle via `const graphBundle = !!(md.outputs?.graphEdges || md.network?.graphMode);` and when `graphBundle && !(state.networkLines && state.networkLines.length)`, override the final status cascade with a new warning string — add STRINGS keys pt+en, e.g. "status.bundle_graph_not_restored": pt "Bundle de modo grafo: o resultado (graph_edges.geojson) não é restaurável e a rede vetorial não viaja no bundle — recarregue a rede (.gpkg/OSM) antes de recalcular, senão o Compute usa o motor raster.", en equivalent. Do NOT uncheck vec-graph-mode (config round-trip is deliberate) and do NOT attempt to import graph_edges.geojson (restoring needs the full graph object — a known follow-up owned elsewhere).

**Tests to run:** `Manual browser: export a graph-mode bundle, reload the page, import it over the matching DEM without loading a network — the new warning must show; then load the .gpkg network and confirm Compute runs the graph engine again`

**Invariants — do not break:** New text must go through STRINGS/t() in both pt and en. Do not modify dispatchCompute's engine-selection logic or graph-engine.js. The CHANGELOG trio (CHANGELOG.md + index.html changelog <details> + sw.js comment) moves together with the VERSION bump.

*(Fix approach independently re-verified as sound.)*

---

### [low] loadBundleFile has no decompression size cap — a crafted zip-bomb bundle OOMs the tab before any dimension/length check runs

**Where:** `app.js:9568`  
**Difficulty:** small  
**Fix touches:** `app.js`

**Problem.** loadBundleFile inflates zip members with no guard on decompressed size: JSZip.loadAsync parses the central directory cheaply, but each `.async("string"/"arraybuffer")` call (metadata.jsonld at 9571, energy/passes/alt/network/impassable tifs at 9577-9603, the GeoJSONs at 9605-9615) fully decompresses into memory. Zip format compresses ~1000:1, so a few-hundred-KB crafted bundle can declare multi-GB members; JSON.parse of a giant metadata.jsonld or readRasterFromGeoTIFF of a giant tif kills the tab before the H×W length gates in applyMetadataToUI ever run. Bundles are a sharing format between users, so hostile input is plausible; impact is limited to a tab crash (no data loss — state is in localStorage).

**Evidence.**
```
app.js 9568-9571: `const zip = await JSZip.loadAsync(await file.arrayBuffer());\n      const mdEntry = zip.file("metadata.jsonld") || zip.file("metadata.json");\n      if (!mdEntry) throw new Error(...);\n      md = JSON.parse(await mdEntry.async("string"));` — no size check anywhere in the reader.
```

**Fix approach.** Add a size guard helper in loadBundleFile using JSZip 3.10's per-entry metadata: `const entrySize = (e) => e?._data?.uncompressedSize ?? 0;` and before each .async() call throw when the entry exceeds a cap — 64 MiB for metadata.jsonld and each .geojson, and for rasters `state.dem ? state.dem.H*state.dem.W*8 + 65536 : 1.5e9` bytes (Float64 worst case plus TIFF overhead; fixed ceiling when no DEM is loaded yet). Throwing inside the existing try/catch surfaces via the already-escaped t("status.reload_failed", escapeHtml(err.message)) path; use a STRINGS-backed message if it is user-facing.

**Tests to run:** `Manual browser: normal bundle round-trip still loads (including a large legit bundle from the 135M-cell DEM — the cap must clear H*W*8); a synthetic zip with an oversized stored member is rejected with the error status instead of hanging the tab`

**Invariants — do not break:** Caps must never reject legitimate bundles: the flagship DEM is ~135M cells, so passes.tif decompresses to ~1.08 GB — size the raster cap from H*W*8, not a small constant. `_data.uncompressedSize` is JSZip-internal; guard with optional chaining so a JSZip upgrade degrades to no-cap rather than breaking imports. Bump sw.js VERSION + changelog trio if shipped.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: Replace the raster-cap formula. Derive the expected cell count primarily from the bundle's OWN declared dimensions (already parsed, cheap, before any raster `.async()` call), not from whatever DEM happens to be loaded in the tab: `const bundleCells = Number.isFinite(md?.dem?.H) && Number.isFinite(md?.dem?.W) ? md.dem.H * md.dem.W : null;` then combine with a hard absolute ceiling so a malicious bundle can't defeat the cap by simply lying about `md.dem.H`/`W`, e.g.: `const HARD_CELL_CEILING = 200e6; // generous headroom over the ~135M-cell flagship DEM` and `const cellCap = Math.min(bundleCells ?? (state.dem ? state.dem.H*state.dem.W : 50e6), HARD_CELL_CEILING);` then `rasterByteCap = cellCap*8 + 65536` (keep float64/passes as the worst case). This both (a) clears legitimate bundles regardless of what DEM is currently loaded in the tab (using the bundle's own self-reported dims, which for every export always exist per app.js:9293-9304) and (b) still bounds a hostile bundle that fabricates enormous `md.dem.H`/`W` values, since the absolute ceiling caps it regardless. Also note as a residual, secondary gap (may be worth a one-line comment rather than blocking the fix): the raster cap only bounds the *zip-layer* decompression size; a small-but-valid GeoTIFF using its own internal compression (e.g. LZW/Deflate strips) could still expand to a large in-memory raster inside `readRasterFromGeoTIFF`'s `image.readRasters()` (app.js:8642-8658) even after clearing the zip-entry cap. If closing that gap is in scope, check `image.getWidth()*image.getHeight()*bytesPerSample` against the same cap right after `tiff.getImage()` but before calling `readRasters()`.

---

### [info] applyMetadataToUI never re-fires the #mode change handler, so the e-max-mode row visibility goes stale for bundles without md.config (census CLI bundles, pre-v40-era bundles)

**Where:** `app.js:9667`  
**Difficulty:** trivial  
**Fix touches:** `app.js`

**Problem.** The #mode select's change handler toggles the budget-mode row: `budgetModeRow.style.display = modeSel.value === "round" ? "" : "none"` (app.js 1200-1208). applyMetadataToUI sets the value with set("mode", p.mode) (app.js 9667) and later dispatches synthetic change events for want-topn, want-density and maximize (9770-9777) — but not for mode. For v3 app-exported bundles this is masked because applyConfig fires PERSIST_REFIRE (which includes "mode") first; but bundles WITHOUT md.config — notably census/census-density.mjs CLI bundles (its buildMetadata writes no config key) and older bundles — restore mode="round" with the 'Budget applies to' (e-max-mode) row still hidden, or restore mode="from" with the row incorrectly visible. The eMaxMode VALUE still applies to the compute; only the row visibility desyncs (cosmetic but confusing when reproducing a round-trip census bundle with a budget).

**Evidence.**
```
app.js 9667: `set("mode", p.mode);` with no dispatch; app.js 9770-9777 dispatch change only for want-topn / want-density / maximize; app.js 1203-1206: `const syncBudgetMode = () => { budgetModeRow.style.display = modeSel.value === "round" ? "" : "none"; }; modeSel.addEventListener("change", syncBudgetMode);`; census/census-density.mjs buildMetadata (line 221-278) emits no `config` property.
```

**Fix approach.** In applyMetadataToUI, next to the existing synthetic dispatches (app.js ~9770), add: `const modeSel2 = document.getElementById("mode"); if (modeSel2) modeSel2.dispatchEvent(new Event("change"));` (mirroring the want-topn/want-density/maximize pattern). Dispatching is idempotent for bundles that carried config.

**Tests to run:** `Manual browser: build a census bundle (node census/census-density.mjs --mode round ...) or hand-edit a bundle's metadata.jsonld to remove config and set params.mode="round"; import it and confirm the e-max-mode row is visible`

**Invariants — do not break:** The dispatched change must not trigger a recompute or markStyleDirty (the mode handler only toggles row visibility — verified); keep the colormap selects OUT of any re-fire (their handler flags a bogus style-dirty, per the PERSIST_REFIRE comment at app.js 779-784). Bump sw.js VERSION + changelog trio if shipped.

*(Fix approach independently re-verified as sound.)*

---

## LANE-WORKER — energy-worker.js + test-worker-pool.mjs

**Files:** `energy-worker.js, test-worker-pool.mjs`

### [medium] Per-cell top-N repulsion accepts penalty < 1, subtracting cost and creating negative A* edges (graph engine clamps >= 1; raster does not)

**Where:** `energy-worker.js:1561`  
**Difficulty:** trivial  
**Fix touches:** `energy-worker.js`, `test-worker-pool.mjs`

**Problem.** The raster top-N loop sanitises the penalty as `const pen = penalty > 0 ? penalty : 1.0;` (energy-worker.js:1561), so any value in (0,1) passes through. The UI allows it: index.html:1063 `<input type="number" id="penalty" value="2.0" min="0" step="0.1">` and app.js:5536 only clamps `Math.max(0, ...)`. In per-cell mode astar then computes `mult = Math.pow(penalty, used) < 1` and `edge += (mult - 1) * distCost` — a NEGATIVE addition (energy-worker.js:716-721). On descent edges the base v2Edge cost is clamped to ~0, so the total edge weight goes negative, violating A*'s non-negative-edge requirement: settled-cell finality no longer holds, the v49 admissible heuristic is no longer a lower bound of the penalised graph, and routes 2..N (and their energies) can be arbitrarily wrong — including an 'alternative' reported cheaper than the optimal route #1. The graph engine already guards exactly this: graph-engine.js:613 `const pen = penalty > 1 ? penalty : 1;`. Failure scenario: user lowers the penalty to 0.5 to get 'weaker' repulsion (a natural reading of the 'penalty / strength' label), keeps per-cell mode, requests 3 routes: routes 2-3 are attracted onto route 1's cells with negative edge weights and the search silently returns suboptimal/incoherent paths and energies with no warning.

**Evidence.**
```
energy-worker.js:1561 `const pen = penalty > 0 ? penalty : 1.0;`; energy-worker.js:716-721 `const used = usedCount[nIdx] | 0; if (used > 0) { const mult = Math.pow(penalty, used); edge += (mult - 1) * distCost; }`; graph-engine.js:613 `const pen = penalty > 1 ? penalty : 1;`; index.html:1063 `min="0"`; app.js:5536 `Math.max(0, parseFloat(...) || 2.0)`.
```

**Fix approach.** In energy-worker.js line 1561 mirror the graph engine's clamp for the per-cell mode only: `const pen = repulsionMode === "per-cell" ? (penalty > 1 ? penalty : 1) : (penalty > 0 ? penalty : 1.0);`. Do NOT clamp linear/square — there `edge += (penalty/denom)*distCost` is non-negative for any penalty > 0 and sub-1 strengths are legitimate. Optionally add a regression case to test-worker-pool.mjs: run wantTopN with repulsionMode 'per-cell', penalty 0.5, nRoutes 3, and assert every returned route energy is finite, >= 0, and >= routes[0].energy - 1e-9 (with the clamp, penalty 0.5 behaves as 1 = no repulsion).

**Tests to run:** `node test-worker-pool.mjs`, `node backend/test-backend.mjs (routes are browser-only; must stay green untouched)`

**Invariants — do not break:** No change to the base v2Edge cost model or to penalty >= 1 behaviour (existing top-N results must stay bit-identical for penalty >= 1). No Rust change (top-N is browser-only per CLAUDE.md). Keep the HTML min="0" (linear/square use sub-1 strengths). If shipped: bump sw.js VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Top-N alternative routes report the penalised A* search cost as their energy — inflated kJ displayed, exported, and inconsistent with graph mode

**Where:** `energy-worker.js:1590`  
**Difficulty:** small  
**Fix touches:** `energy-worker.js`, `test-worker-pool.mjs`

**Problem.** In the raster top-N loop, astar() accumulates the repulsion penalty into E (energy-worker.js:715-728 adds `(mult-1)*distCost` or `(penalty/denom)*distCost` to each edge before `tentative = g + edge`), and the loop reports that penalised total as the route's energy (`routes.push({ ..., energy: res.energy, ... })` at line 1588-1593, where res.energy = E[goalIdx]). Route #1 is unaffected (no cells used yet), but routes 2..N carry artificial repulsion cost that is NOT energy to ride the route. In 'linear'/'square' repulsion modes EVERY cell has a finite distance to route 1 after iteration 1, so every edge of routes 2..N is inflated by penalty/(d+1) (or /(d²+1)) times the distance-cost term; in default 'per-cell' mode the inflation hits all cells shared with prior routes — and routes always share the src/dst endpoint funnels. The wrong number is shown in the result meta (`E=${r.energy.toExponential(2)}` app.js:6660), the map tooltip (app.js:6854), and is persisted into exported bundles as routes.geojson `energy` property (app.js:9137). The graph engine explicitly does the opposite: graph-engine.js:608-609 'Route energies are reported UN-penalised (true energy)' and computes `pathEnergy(g, costAB, costBA, path, false)` at line 626 — so the same scenario run in raster vs graph mode reports different kJ for equivalent alternatives. Failure scenario: load a DEM, set src+dst, enable top-N with nRoutes=3, repulsion 'linear', penalty=2 (the default strength): route 2's displayed/exported kJ is systematically ~10-40% above its true riding energy, and a user comparing 'route 2 costs X kJ more than route 1' gets a number that is partly the synthetic repulsion term.

**Evidence.**
```
energy-worker.js:1588-1593: `routes.push({ path: res.path, energy: res.energy, length: res.length, shared, });` where astar's E includes `edge += (mult - 1) * distCost;` / `edge += (penalty / denom) * distCost;` (lines 719-727). Contrast graph-engine.js:608-609: `// Route energies are reported UN-penalised (true energy)` and line 626 `const energy = pathEnergy(g, costAB, costBA, path, false);`. Export: app.js:9137 `energy: r.energy,` into routes.geojson.
```

**Fix approach.** In energy-worker.js, in the `if (wantTopN && wantPath)` block (lines ~1562-1600), after `if (!res.path) break;`, recompute the un-penalised energy of res.path and report it instead of res.energy when `!maximize`: iterate consecutive flat-index pairs (a,b) of res.path, derive (ar,ac,br,bc) via `(a/W)|0` etc., `d = Math.hypot((br-ar)*dy, (bc-ac)*dx)`, `dh = (mode === "to") ? height[a]-height[b] : height[b]-height[a]` (matching astar's `reverse` scoring direction), accumulate `trueE += v2Edge(d, dh, cost)` in f64, then `routes.push({ path: res.path, energy: maximize ? res.energy : trueE, length: res.length, shared })`. astar uses no portals, so consecutive path cells are always 8-neighbours and v2Edge over the pair is exactly the base edge cost. Update test-worker-pool.mjs line 136: penalised energies were monotone non-decreasing, true energies only guarantee >= the optimum — change the assertion to `x.energy >= r.routes[0].energy - 1e-9`. Existing route-#1 assertions (lines 178-180 tolerance 1e-2; lines 194-197 tolerance 5e-2) already absorb the f32-field vs f64-recompute delta. Optionally note the change in help.p.topn.

**Tests to run:** `node test-worker-pool.mjs`, `node backend/test-backend.mjs (after cd backend && cargo build --release; routes are browser-only so this must stay green untouched)`

**Invariants — do not break:** Do NOT change astar()'s internal search cost — the penalised cost must keep driving the search (route diversity depends on it); only the REPORTED energy changes. Route #1's energy must stay equal to the field E[goal] within the existing test tolerances. No Rust change (the backend produces no routes — CLAUDE.md: top-N is browser-only). If shipped: bump sw.js VERSION and move the changelog trio (CHANGELOG.md + index.html <details id="changelog"> + sw.js comment) in lockstep; UI copy through STRINGS/t().

*(Fix approach independently re-verified as sound.)*

---

### [low] DP hard-masks the start cell, breaking the documented soft-seed contract and producing a misleading 'try a larger L' warning

**Where:** `energy-worker.js:1073`  
**Difficulty:** trivial  
**Fix touches:** `energy-worker.js`

**Problem.** dijkstra() and astar() deliberately tolerate an off-mask seed (energy-worker.js:595-599: 'mask check is soft: if start/goal aren't on the (effective) mask the search can still run ... top-N still produces routes when the user dropped src/dst before loading a vector network constraint') — the seed pops first and its on-mask neighbours are relaxed. maxCostPathOfLength does not: its relaxation skips off-mask predecessors unconditionally (`if (!mask[n]) continue;` line 1073), so with an off-mask start no cell ever becomes finite at layer 1 and the DP always returns error 'unreachable'. Failure scenario: user places src, then loads a vector network with 'constrain compute to network' (src now sits off the effective mask), enables maximize with L>0: the inverted-Dijkstra fallback still draws a path (soft seed), but the DP that is supposed to supersede it always fails, and the surfaced warning tells the user to 'try a larger L (at minimum ~Chebyshev distance between src and dst)' — a wrong diagnosis that no L fixes.

**Evidence.**
```
energy-worker.js:1073 `if (!mask[n]) continue;` (predecessor loop) versus the documented soft-seed contract at 595-599 and dijkstra's behaviour (seed pushed unconditionally at line 220, only neighbours mask-checked at 256). Warning text at 1635-1637: `Length-constrained DP did not run (${dp.error}). Showing the inverted-Dijkstra path instead — try a larger L ...`.
```

**Fix approach.** In maxCostPathOfLength change line 1073 from `if (!mask[n]) continue;` to `if (!mask[n] && n !== start) continue;` so the start cell can act as a predecessor exactly like dijkstra/astar's soft seed. Leave the goal hard-masked (line 1064) — dijkstra and astar also refuse to relax INTO off-mask cells, so a hard goal is the consistent behaviour. Note: if the off-mask start's height is NaN (nodata), v2Edge yields NaN and `cand > bestVal` stays false — same no-path outcome as today, which is fine.

**Tests to run:** `node test-worker-pool.mjs`, `node backend/test-backend.mjs (DP is browser-only; must stay green untouched)`

**Invariants — do not break:** On-mask start behaviour must stay bit-identical. No Rust change (DP is browser-only). If shipped: bump sw.js VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [low] Length-constrained max-cost DP ignores the travel direction for mode "to" — v49's reverse treatment was applied to astar but not to maxCostPathOfLength

**Where:** `energy-worker.js:1613`  
**Difficulty:** small  
**Fix touches:** `energy-worker.js`, `test-worker-pool.mjs`

**Problem.** v49 fixed prior-review finding C6 by scoring top-N A* in the field's travel direction (`reverse: mode === "to"` at energy-worker.js:1581), but the layered-DP dispatch right below it (`if (maximize && maximizeLength > 0 && wantPath)` at 1613-1620) passes no direction: maxCostPathOfLength always scores each edge with `const dh = hv - height[n];` (line 1080), i.e. travel seed→goal. In mode "to" the field, the single path, and top-N all measure travel goal→seed (dst→seed), and under the asymmetric v2 cost model the max-cost L-edge path differs by direction. Failure scenario: mode "to", maximize checked, maximize-length L>0, dst set (all reachable via the UI — nothing disables the mode selector under maximize): the DP path/energy that replaces the displayed path is the seed→dst-direction maximum, disagreeing with the reverse field it is overlaid on and with what a rider travelling dst→seed would experience.

**Evidence.**
```
energy-worker.js:1580-1581 (astar call): `// ... score the routes in that same direction.` `reverse: mode === "to",` — versus the DP call at 1614-1620: `const dp = maxCostPathOfLength({ height, mask: effMask, H, W, startR: seedR, startC: seedC, goalR, goalC, cost, dx, dy, L: maximizeLength, });` (no reverse), and inside the DP at line 1080: `const dh = hv - height[n];`.
```

**Fix approach.** Add `reverse = false` to maxCostPathOfLength's opts destructuring (energy-worker.js ~1012-1019); change line 1080 to `const dh = reverse ? height[n] - hv : hv - height[n];`; pass `reverse: mode === "to"` in the dispatch call at 1614-1620, mirroring the astar call at 1581. Round mode stays forward (outbound leg), consistent with the existing top-N disclosure (STRINGS key route.round_note). Add a test-worker-pool.mjs case on the existing asymmetric test grid: run mode 'to' with maximize:true, maximizeLength set to a feasible L, and assert dp path energy equals the f64 sum of v2Edge(d, height[a]-height[b]) over consecutive path pairs (the dst→seed direction).

**Tests to run:** `node test-worker-pool.mjs`, `node backend/test-backend.mjs (DP is browser-only; must stay green untouched)`

**Invariants — do not break:** Forward (mode "from") DP output must stay bit-identical (reverse defaults to false). The DP stays portal-free and browser-only — no backend/src/main.rs change. Do not touch v2Edge. If shipped: bump sw.js VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [low] DP-failure warning is hardcoded English display text, bypassing the STRINGS/t() i18n invariant

**Where:** `energy-worker.js:1633`  
**Difficulty:** small  
**Fix touches:** `app.js`, `energy-worker.js`

**Problem.** When the layered DP refuses (memory cap, unreachable, backtrack_fail), the worker posts a hand-authored English sentence (`Length-constrained DP did not run (...). Showing the inverted-Dijkstra path instead — try a larger L (at minimum ~Chebyshev distance between src and dst).`, energy-worker.js:1633-1638) which app.js renders verbatim into the status bar (app.js:5988-5994 `status.innerHTML = ... escapeHtml(m.message)`, and the second warning handler at ~6217). CLAUDE.md's i18n invariant requires all display text to go through the STRINGS table / t(); v49's C14 fix routed the app.js hardcoded strings through STRINGS but missed this worker-authored one. Failure scenario: a PT-language user (the default audience) triggers the DP memory cap on a large DEM and gets an untranslated English status message.

**Evidence.**
```
energy-worker.js:1633-1637: `postMessage({ kind: "warning", message: `Length-constrained DP did not run (${dp.error}). ` + `Showing the inverted-Dijkstra path instead — try a larger L ` + `(at minimum ~Chebyshev distance between src and dst).`, });` and app.js:5993 `status.innerHTML = `<span style="color:#ffb86b">${escapeHtml(m.message)}</span>`;`.
```

**Fix approach.** Have the worker post a structured warning: `postMessage({ kind: "warning", key: "warn.dp_skipped", args: [String(dp.error)], message: <current English string as fallback> })`. In app.js, in BOTH warning handlers (the startSingleWorker one at ~5988-5994 and the compare-pair one at ~6217), render `const text = m.key ? t(m.key, ...(m.args || [])) : m.message;` and keep the escapeHtml wrap before innerHTML. Add a `warn.dp_skipped` entry to the STRINGS table (app.js) with pt and en variants using the existing {0} placeholder convention (t() already supports args — see t("route.terrain_meta", ...) at app.js:6677), covering the 'DP não rodou ({0}) — mostrando o caminho do Dijkstra invertido; tente um L maior' content.

**Tests to run:** `node test-worker-pool.mjs`, `browser smoke: trigger the DP memory cap (large DEM + L>0) in PT and EN and confirm the translated status line`

**Invariants — do not break:** escapeHtml before any status.innerHTML interpolation MUST be preserved (CLAUDE.md security invariant — dp.error is worker-generated but the pattern must not regress). Keep the plain `message` fallback so node harnesses that read m.message keep working. If shipped: bump sw.js VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

### [info] Engine layer does not guard eMax under maximize — the v49 C1 fix lives only in app.js, so any non-app sender (stale cached app.js, census/bundle harnesses) still gets a silently empty field

**Where:** `energy-worker.js:1350`  
**Difficulty:** small  
**Fix touches:** `energy-worker.js`, `backend/src/main.rs`

**Problem.** Prior-review finding C1 (kJ budget applied unconverted to inverted costs under maximize, pruning nearly everything and emptying the field) was fixed in v49 only at the app.js dispatch layer (`if (maximize) eMax = 0;` app.js:5551, mirrored at 8279 for the estimator). The worker itself still prunes with `if (eMax > 0 && tentative > eMax) continue;` on inverted costs when both flags arrive (dijkstra:281, densityField:491, astar:731), and backend/src/main.rs likewise honours e_max with maximize on /density. The DP itself is safe — maxCostPathOfLength takes no eMax — but the surrounding inverted-Dijkstra field and top-N A* are not. Failure scenario: a stale SW-cached app.js one update cycle behind (a known-open sw.js characteristic) or an external sender (census harness variant, hand-crafted /density request) ships maximize:true with eMax>0: the engine silently returns a near-empty field around the seed with no error, reproducing C1 for that sender class.

**Evidence.**
```
energy-worker.js:281 `if (eMax > 0 && tentative > eMax) continue;` with `edge = maxEdgeCost - edge` under maximize (272-275); no `maximize`-conditional zeroing anywhere in energy-worker.js (the only guard is app.js:5551 `if (maximize) eMax = 0;`).
```

**Fix approach.** Defense in depth applied to BOTH engines in the same release: in energy-worker.js's run handler, after the msg destructure (~line 1344) compute `const eMaxEff = maximize ? 0 : eMax;` and use eMaxEff everywhere eMax is currently used in that handler (eMaxTotalCap derivation at 1350, densityField/dijkstra/astar calls); in backend/src/main.rs zero the budget at Params ingestion for /density (e.g. after parsing: `if params.maximize { params.e_max = 0.0; }`) — /single already excludes maximize. Both sides must change in lockstep per the port invariant; the existing test-backend.mjs maximize parity cases stay green because both engines change identically.

**Tests to run:** `node test-worker-pool.mjs`, `cd backend && cargo build --release && node test-backend.mjs`, `node census/test-census-sampler.mjs`

**Invariants — do not break:** CRITICAL: JS/Rust bit-parity — any budget-semantics change in energy-worker.js MUST land identically in backend/src/main.rs (CLAUDE.md port invariant) and node backend/test-backend.mjs must pass. Do not touch graph-engine.js's own eMax handling. Behaviour for all current app-originated runs is unchanged (app.js already sends eMax=0 under maximize). If shipped: bump sw.js VERSION + changelog trio.

*(Fix approach independently re-verified as sound.)*

---

## LANE-GRAPH — graph-engine.js + test-graph-engine.mjs

**Files:** `graph-engine.js, test-graph-engine.mjs`

### [medium] Graph-build spatial hash uses string Map keys with 3×3 dilation per sample — GB-scale transient memory and tens of seconds at the 2 M-vertex network cap

**Where:** `graph-engine.js:320`  
**Difficulty:** small  
**Fix touches:** `graph-engine.js`

**Problem.** buildGraph()'s crossings mode builds its segment bucket hash with string keys: every segment inserts each sample's 3×3 neighbourhood as `(rr+dr) + "|" + (cc+dc)` into a Map (plus a per-segment string Set for dedupe), and the v49 T-junction pass re-queries the same buckets per endpoint. At the app's 2 M-vertex network cap this is tens of millions of short-lived key strings, ~10–20 M distinct Map entries (~50–100 B each for key+entry) and millions of Set allocations — roughly 2–3 GB of transient worker heap and heavy GC, on top of the tested-pairs Set. The pass is correctly bucketed (not quadratic), but the constant factor is dominated by string hashing/allocation. Failure scenario: user loads the full São Paulo street network (near the 2 M-vertex cap) and switches to graph mode — the graphBuild worker spends tens of seconds and ~2–3 GB building buckets; on an 8 GB device the worker OOMs and graph mode fails where it could have fit.

**Evidence.**
```
graph-engine.js:299-323: `const buckets = new Map(); // "ri|ci" -> [segIdx,…] … const seen = new Set(); … const key = (rr + dr) + "|" + (cc + dc); if (seen.has(key)) continue; seen.add(key); addBucket(key, s);` and the endpoint scan at 366-368: `const arr = buckets.get((rr + dr) + "|" + (cc + dc));`
```

**Fix approach.** Replace string keys with packed integer keys in buildGraph()'s crossings section: define `const KOFF = 8, KSPAN = 262144;` (covers coordinates up to ~262k cells, far above any DEM) and `key = (rr + dr + KOFF) * KSPAN + (cc + dc + KOFF)` for buckets, seen, and the endpoint lookup `buckets.get((rr + dr + KOFF) * KSPAN + (cc + dc + KOFF))`. Keys stay exact integers (< 2^53). Bucket ITERATION order changes, but per-segment `splits[s]` arrays are sorted before cutting (line 430) and the tested-pairs Set (`pk = a*segs.length+b`) is order-independent, so the emitted graph is identical.

**Tests to run:** `node test-graph-engine.mjs`, `node test-worker-pool.mjs (energy-worker importScripts graph-engine — must still load)`

**Invariants — do not break:** Graph output must be identical for identical input (crossings, T-junction splits, node merge, deck flattening all downstream-order-independent as argued — verify with the fuzz cases in test-graph-engine.mjs); do NOT touch stepCost (it mirrors energy-worker.js v2Edge bit-for-bit); graph-engine.js is a worker subresource — bump sw.js VERSION + changelog trio on ship (SW-cached workers run stale otherwise).

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: 1. Reframe the goal: the packed-integer key swap (KOFF=8, KSPAN=262144, applied to buckets/seen/endpoint lookup exactly as specified) is safe to ship — it preserves output (verified: all `test-graph-engine.mjs` cases pass) and gives a real, reproducible ~40-50% wall-time reduction on a 897k-vertex synthetic network — but it should be sold as a TIME fix, not a memory fix; don't claim it resolves the "2-3GB" figure.

2. To actually cut memory, restructure the bucket hash from `Map<key, Array>` (one JS object per unique key, ~10-20M of them at the documented cap — this is the measured dominant cost, not the key encoding) into a two-pass counting-sort into flat typed arrays: pass 1 counts occurrences per packed key into a `Map<key,count>` (or, better, since the key range is now boundable via KOFF/KSPAN, a `Uint32Array`-backed count table sized to the actual bounding box of the loaded lines, not the full 262144² space); prefix-sum into offsets; pass 2 fills one `Int32Array` of total-entry length using per-key cursors. This eliminates the ~10-20M discrete small-Array allocations (the CSR analogue used elsewhere in this codebase's raster engines) while keeping the candidate-pair scan (`for (let i..) for (let j..)`) working over slices of that flat array instead of `arr[i]`/`arr[j]` from a JS Array. Re-verify with `test-graph-engine.mjs` after this change too (order-independence argument still holds since it only depends on sorted `splits[s]` and the symmetric `tested` pair key, not bucket iteration order).

3. Fix the testsToRun list: drop the `test-worker-pool.mjs` line's "(energy-worker importScripts graph-engine — must still load)" justification — it's incorrect; that harness runs under Node where `importScripts` is undefined, so `energy-worker.js` never even attempts to load graph-engine.js there (energy-worker.js:1166-1167 is gated on `typeof importScripts === "function"`). Keep `node test-graph-engine.mjs` as the correctness regression, and add an explicit manual/browser check per this repo's own verification rule (CLAUDE.md: "JS → load in a browser") — load the app, enable graph mode on a real network, and confirm it still builds — since that's the only way to actually exercise the importScripts path this change touches.

4. Either assert the KOFF/KSPAN packing's range assumption at the top of the crossings block (e.g. compute the actual min/max r,c across `segs` first and throw/fallback to string keys if `(max - min + 2*KOFF) >= KSPAN` or if any coordinate's magnitude could overflow the assumed band) or derive KSPAN dynamically from the observed line-coordinate extent plus a safety margin, so a network whose geometry runs unexpectedly far outside the DEM extent (permitted by the rtree bbox-intersection prefilter, which does not clip individual line geometry to the DEM box) fails loudly/falls back rather than silently aliasing two distinct cells to the same bucket key.

5. `difficulty: "small"` is accurate for the literal key-swap but understates what's needed to actually address the memory claim (item 2 above is a more involved, real restructuring) — relabel or split into two tickets: a "small" time-only fix (ship now) and a separate, larger memory-focused fix (the CSR restructuring).

---

### [medium] New T-junction splitting fails to merge the endpoint with the cut when the gap straddles a nodeOf quantisation boundary — network silently stays disconnected

**Where:** `graph-engine.js:392`  
**Difficulty:** small  
**Fix touches:** `graph-engine.js`, `test-graph-engine.mjs`

**Problem.** v49 added T-junction handling to buildGraph's crossings mode: a polyline ENDPOINT within snapTol of another line's segment interior splits that segment at the perpendicular projection, relying on the quantised node-merge (`nodeOf`: key = Math.round(r/snapTol)+"|"+Math.round(c/snapTol)) to unify the endpoint with the cut. But the endpoint P and its projection Q can be up to snapTol apart, and Math.round(x/snapTol) assigns them DIFFERENT keys whenever they straddle a half-quantum boundary — the segment is then split for nothing and the two lines remain in separate connected components, which is exactly the silent-disconnection failure the feature was shipped to fix. Empirically verified against the v49 engine: with snapTol=0.5, a vertical line ending 0.26 cells (or 0.49 cells) above a horizontal line's interior produces 5 nodes / 2 components (disconnected), while gaps of 0 and 0.2 produce 1 component. So the advertised tolerance (up to snapTol, i.e. 15 m on coarse DEMs after the v49 cap) only works reliably for near-exact touches; for gaps in roughly the upper half of the tolerance it fails on a per-axis coin flip. Failure scenario: a hand-drawn or non-noded .gpkg network where a street ends ~5-14 m short of the street it tees into (common in drawn GPX/geojson) → graph-mode routes and passes still dead-end at the junction with no warning, contradicting the v49 changelog claim that "T-junctions now join the network".

**Evidence.**
```
graph-engine.js:383-392 (T-junction scan):
            const t = ((pr - S[0]) * dr1 + (pc - S[1]) * dc1) / len2;
            ...
            const d2 = (pr - qr) * (pr - qr) + (pc - qc) * (pc - qc);
            if (d2 > snapTol * snapTol) continue;
            ...
            splits[s].push(t);
and nodeOf at 401-402: `const key = Math.round(r / snapTol) + "|" + Math.round(c / snapTol);`
Empirical run (buildGraph, snapTol 0.5): "gap 0.2: nodes=4 edges=3 components=1 / gap 0.26: nodes=5 edges=3 components=2 / gap 0.49: nodes=5 edges=3 components=2"
```

**Fix approach.** Make the T-junction cut node reuse the ENDPOINT's own coordinates so nodeOf is guaranteed to produce the same key. Concretely, in buildGraph change the `splits` entries pushed by the T-junction scan (graph-engine.js:392) from a plain number to an object `{ t, or: pr, oc: pc }` (override coords = the touching endpoint P); leave crossing-scan pushes as plain numbers. In the emit loop (lines ~427-435), normalise each cut to `{t, or?, oc?}`, sort by t, and when computing `na`/`nb` for an interior cut call `nodeOf(or ?? r1+(r2-r1)*t, oc ?? c1+(c2-c1)*t)` — placing the cut node AT P (within snapTol of the true projection, so geometrically equivalent) guarantees P and the cut quantise identically. Keep the ta=0/tb=1 endpoints on the segment's own vertices. Preserve deck bookkeeping: arcA/arcB (nodeDeck interpolation) must still use the sorted t values, not the override coords. Add a regression case to test-graph-engine.mjs: endpoint 0.26 and 0.49 cells off a segment interior with snapTolCells 0.5 → assert one connected component.

**Tests to run:** `node test-graph-engine.mjs`, `node test-worker-pool.mjs`

**Invariants — do not break:** Crossing-scan behaviour must not change (both segments already split at the SAME point, so identical keys are guaranteed — keep that path byte-identical). Do not weaken the layer/deck suppression rules (deck-over-street at different layer is never a junction) or the z-tolerance rule. The nodeOf quantisation itself must stay as-is for all other callers (coincident-endpoint merging, chainDeckFlattening keyOf). graph-engine.js is SW-precached: bump sw.js VERSION + the changelog trio in lockstep, single release commit authored as Claude, Co-Authored-By Danilo.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Graph-mode top-N ignores mode "até" (to): field and routes are forward-scored, diverging from the v49-fixed raster engine

**Where:** `graph-engine.js:704`  
**Difficulty:** small  
**Fix touches:** `graph-engine.js`, `test-graph-engine.mjs`

**Problem.** v49 fixed the raster A* top-N to score "até" (mode "to") routes in the true travel direction (energy-worker.js astar now takes reverse: mode === "to"), but the graph engine ("seguir os vetores" mode, graph-engine.js) was not updated. In computeGraph, the wantTopN branch returns early BEFORE the mode dispatch and hardcodes forward direction twice: the base energy field runs `dijkstra(g, costAB, costBA, [params.srcNode], eMax, false)` (reverse hardcoded false), and `topN()` internally runs `dijkstra(..., false)` (line 621) and scores routes with `pathEnergy(g, costAB, costBA, path, false)` (line 626). The non-top-N graph "to" branch (line 757-764) correctly uses `reverse = params.mode === "to"` and `pathEnergy(..., params.mode === "to")`. Failure scenario: load a DEM + vector network, enable graph mode, set mode to "até o ponto" with a destination and "Calcular top-N rotas" on → the rendered energy field flips to "from"-semantics (cost FROM the reference instead of TO it) compared to the identical run with top-N off, and every route energy scores src→dst travel instead of dst→src. On asymmetric terrain (always, for cycling costs) the values differ substantially and route ranking can be wrong for the true direction. The raster engine, fixed in v49, gives the correct reversed values for the same inputs — the two engines now disagree.

**Evidence.**
```
graph-engine.js:703-708:
    if (params.wantTopN && params.dstNode >= 0) {
      const base = dijkstra(g, costAB, costBA, [params.srcNode], eMax, false);
      ...
      const { routes } = topN(g, costAB, costBA, params.srcNode, params.dstNode, eMax, ...);
versus the non-topN branch at 757-759:
      const reverse = params.mode === "to";
      const tree = dijkstra(g, costAB, costBA, [params.srcNode], eMax, reverse);
and energy-worker.js:1581 (the v49 raster fix): `reverse: mode === "to",`
```

**Fix approach.** In graph-engine.js computeGraph's wantTopN branch (line ~703): compute `const rev = params.mode === "to";`, pass it to the base field `dijkstra(g, costAB, costBA, [params.srcNode], eMax, rev)`, and add a trailing `reverse` parameter to `topN(g, costAB, costBA, src, dst, eMax, nRoutes, penalty, distCoeff, reverse)`. Inside topN, thread it into its internal call `dijkstra(g, pAB, pBA, [src], eMax, reverse)` (line 621) and into `pathEnergy(g, costAB, costBA, path, reverse)` (line 626). The penalty bump is added symmetrically to pAB and pBA so it needs no change. Round mode stays forward-only, matching the raster engine's disclosed outbound-leg behaviour. Add a test case to test-graph-engine.mjs: on an asymmetric slope, assert that mode "to" + topN route #1 energy equals the reverse-field E[dst] (mirror of the new mode-to test in test-worker-pool.mjs).

**Tests to run:** `node test-graph-engine.mjs`, `node test-worker-pool.mjs`, `cd backend && cargo build --release && node test-backend.mjs`

**Invariants — do not break:** Do NOT touch the raster astar or energy-worker.js dispatch (already correct). Graph mode stays portal-blind (never add portal handling). Route energies stay UN-penalised (true energy). The graph engine has no Rust twin, so no backend parity work — but run the backend parity test anyway to prove nothing leaked. If any served file changes, bump sw.js VERSION and move the changelog trio (CHANGELOG.md + index.html help-modal <details id="changelog"> + sw.js comment) in lockstep as one release commit authored as Claude with Danilo as Co-Authored-By. UI text (if any) must go through STRINGS/t().

*(Fix approach independently re-verified as sound.)*

---

### [low] Graph-mode deck flattening ignores mapped OSM ele tags — the raster portal model honours them, so the two engines route the same bridge differently

**Where:** `graph-engine.js:263`  
**Difficulty:** medium  
**Fix touches:** `app.js`, `graph-engine.js`, `test-graph-engine.mjs`

**Problem.** The raster bridge-portal path pulls node/way `ele` tags from Overpass (app.js:3412-3452, loadOsmBridges) and buildPortals ships them as portalHU/portalHV (app.js:5787-5788, 'deck-end ele (NaN = use DEM)') so a mapped bridge's deck cost uses surveyed deck elevations. The graph engine has no ele channel at all: loadOsmNetwork's streets query (app.js:3326-3327) never requests ele nodes, meta rows carry only {deck, layer} (app.js:3350), and graph-engine.js buildGraph derives every deck's h0/h1 purely from sampleHeight on the DEM at the line ends (lines 263-267), as does chainDeckFlattening's gA/gB (lines 219-220). On bridges whose abutment DEM cells are contaminated (e.g. FABDEM leakage under large viaducts) or whose OSM ends carry ele, the raster portal and the graph deck disagree on deck height, so the same physical bridge costs differently — and routes divergently — between the two engines.

**Evidence.**
```
const h0 = sampleHeight(height, mask, H, W, ln[0][0], ln[0][1]);
        const h1 = sampleHeight(height, mask, H, W, ln[ln.length - 1][0], ln[ln.length - 1][1]);  // graph-engine.js:263-264, no ele input; app.js:3350: meta.push(deck ? { deck: true, layer } : { deck: false, layer: 0 });
```

**Fix approach.** (1) app.js loadOsmNetwork (line 3326): extend the Overpass query to also return ele nodes of deck ways: `[out:json][timeout:90];way["highway"](<bbox>)->.hw;.hw out geom;(way.hw["bridge"]["bridge"!="no"];way.hw["tunnel"="yes"];)->.decks;node(w.decks)["ele"];out body;`. Build an eleByCoord map exactly like loadOsmBridges does (app.js:3426-3432: key `${lat.toFixed(7)},${lon.toFixed(7)}`), and for each deck way compute eleA/eleB with the SAME fallback chain as app.js:3441-3452 (end-vertex ele ?? way-level ele ?? nearest tagged vertex from that end ?? null). Store them in the meta row: `meta.push(deck ? { deck: true, layer, eleA, eleB } : { deck: false, layer: 0 })`. (2) graph-engine.js buildGraph deckOf construction (lines 257-268): `const m = lineMeta[li];` then `const h0 = Number.isFinite(m.eleA) ? m.eleA : sampleHeight(...); const h1 = Number.isFinite(m.eleB) ? m.eleB : sampleHeight(...)`. (3) chainDeckFlattening (line 157): for the chain's outer ground elevations gA/gB (lines 219-220), first consult the terminal member's mapped ele orientation-aware (for `first`: first.forward ? lineMeta[first.li].eleA : lineMeta[first.li].eleB; symmetric for `last`), falling back to sampleHeight. (4) Round-trip: the network export writes meta attrs at app.js:2799 ({deck, layer}) — add eleA/eleB there and in the corresponding gpkg-attrs reader (grep app.js for where attrs.deck is parsed back into networkLinesMeta) so exported networks keep deck elevations. (5) Add a test to test-graph-engine.mjs: a deck line spanning a synthetic valley DEM with lineMeta {deck:true, layer:1, eleA:30, eleB:30} must produce a flat 30 m edge profile (and without ele, the current DEM-endpoint behaviour). The .gpkg live-load path is unaffected (app.js:3224 sets networkLinesMeta = null).

**Tests to run:** `node test-graph-engine.mjs`, `node test-worker-pool.mjs`, `browser smoke: OSM streets pull over a mapped bridge, graph-mode compute, compare deck profile with the raster 1d portal view`

**Invariants — do not break:** state.bridges / state.bridgesToken must stay OUT of computeNetworkGraphToken (load-bearing cache rule — this change rides networkLinesMeta, which already invalidates transitively on network reload); do not touch stepCost or the raster portal code (buildPortalAdj/build_portals bit-parity); missing/absent ele must reproduce today's sampleHeight behaviour exactly; sw.js VERSION + changelog trio on deploy.

*(Fix approach independently re-verified as sound.)*

---

### [low] Graph T-junction splitting covers polyline ENDPOINTS only — an interior VERTEX resting on another line's segment interior still creates no junction

**Where:** `graph-engine.js:362`  
**Difficulty:** small  
**Fix touches:** `graph-engine.js`, `test-graph-engine.mjs`

**Problem.** The v49 T-junction fix in buildGraph's crossings mode (graph-engine.js:350-395) iterates only each polyline's two endpoints (`for (const P of [ln[0], ln[ln.length - 1]])`), projecting them onto nearby segments of other lines and splitting there. A non-noded .gpkg or hand-drawn network where a line's INTERIOR vertex rests on another line's segment interior (e.g. line A = [[0,0],[2,2],[0,4]] with its middle vertex on line B = [[0,2],[4,2]]) still produces no split: segIntersect (line 136-144) rejects the contact because A's crossing happens exactly at a vertex (t at 0/1 is excluded by design), and the endpoint loop never visits A's middle vertex. The two lines stay in disconnected components and graph-mode routes/passes silently never traverse the junction — the same failure class C29 was supposed to close, just one vertex inward. The same gap means a line that properly CROSSES another exactly at one of its own interior vertices is also missed.

**Evidence.**
```
for (let li = 0; li < lines.length; li++) {
        const ln = lines[li];
        if (ln.length < 2) continue;
        for (const P of [ln[0], ln[ln.length - 1]]) {
```

**Fix approach.** In graph-engine.js buildGraph, change the T-junction loop (line 362) to visit ALL vertices: replace `for (const P of [ln[0], ln[ln.length - 1]])` with `for (let vi = 0; vi < ln.length; vi++) { const P = ln[vi]; ... }`. Everything inside the loop stays identical (bucket candidate lookup, same-polyline skip, deck/layer suppression at lines 376-379, perpendicular projection with the t in (eps,1-eps) guard, snapTol distance check, zTol check, splits[s].push(t)). This works because the emit loop (lines 423-444) already creates a node at EVERY polyline vertex (each vertex is a segment endpoint, cuts always include 0 and 1), so nodeOf's quantised merge (line 401-406) unifies the interior vertex with the new cut node exactly as it does for endpoints. Perf is bounded: app.js caps networkLines at 2M vertices (app.js:3287) and the candidate lookup reuses the existing spatial-hash buckets. Add a regression case to test-graph-engine.mjs: lines [[0,0],[2,2],[0,4]] and [[0,2],[4,2]], junctionMode 'crossings', assert ONE connected component (build the graph, BFS over edges) and that a route from (0,0) to (4,2) exists; keep the existing endpoint-T-junction test green.

**Tests to run:** `node test-graph-engine.mjs`, `node test-worker-pool.mjs`, `browser smoke: draw two lines forming an interior-vertex T in graph mode and confirm a route crosses the junction`

**Invariants — do not break:** Do NOT touch stepCost (the cross-module stepCost≡v2Edge parity test must keep passing); keep the deck/layer junction-suppression clause inside the new loop (a deck vertex touching a street at a different layer must still NOT connect); node quantisation (snapTol) semantics unchanged; graph-engine.js is SW-precached — bump sw.js VERSION + changelog trio on deploy (see memory note: stale SW-cached workers).

*(Fix approach independently re-verified as sound.)*

---

## LANE-BACKEND — backend/src/main.rs

**Files:** `backend/src/main.rs, backend/test-backend.mjs`

### [medium] Backend stamps its idle clock at request ARRIVAL only, so any cloud request longer than 900 s arms the in-VM watchdog to stop the VM in the gap between a compare run's two sequential requests (or instantly defeat keep-warm)

**Where:** `backend/src/main.rs:1151`  
**Difficulty:** trivial  
**Fix touches:** `backend/src/main.rs`

**Problem.** LAST_COMPUTE_AT is stored only when a /density or /single request arrives (main.rs lines 1151-1157), never at completion. tiny_http serves requests sequentially, so DURING a compute /health is unreachable and the watchdog's failed curl correctly counts as busy — but the moment a long request's response finishes streaming, idle_seconds jumps to the full request duration. IDLE_MAX_S is 900 s and big-DEM cloud density runs realistically exceed 15 minutes (the memory-bounded slice cap limits a huge DEM to 1-2 concurrent slices regardless of 96 cores — CLAUDE.md documents the 3-8x serialization). Concrete failure: density + compare in Cloud mode runs scenario A then scenario B sequentially (app.js startDensityCompare, lines 6284-6286, `await densityField(...)` twice); scenario A takes 20 min; in the 5-30 s client-side gap between A's response and B's request (parsing A's ~GB response + buildComputeGrid + upload start) the once-a-minute watchdog reads idle_seconds≈1200 > 900 and `shutdown -h now` — scenario B's fetch dies, the app reports 'VM da nuvem interrompida' and recomputes the whole scenario in the browser (slow, OOM-prone). Same root cause instantly stops a keep-warm VM after any >15-min run, defeating the 'Manter VM ligada entre cálculos' option. The code comment (lines 1148-1150) assumes runs of 'poucos minutos << 900 s', which the 96-vCPU cloud path exists to exceed.

**Evidence.**
```
main.rs:1151-1157 `(Method::Post, "/density") => {\n    LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);\n    handle_density(req)\n}\n(Method::Post, "/single") => {\n    LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst);\n    handle_single(req)\n}` — no store after the handler returns; app.js:6284-6286 `const A = await densityField({ useNetwork: true, ... }); ... const B = await densityField({ useNetwork: false, ... });` (sequential).
```

**Fix approach.** In backend/src/main.rs's request loop, stamp the idle clock at COMPLETION as well as arrival: `(Method::Post, "/density") => { LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst); handle_density(req); LAST_COMPUTE_AT.store(unix_now_secs(), Ordering::SeqCst); }` and identically for "/single" (handle_density/handle_single return () after responding, so the post-stamp lands right after the response finishes streaming). Update the comment at lines 1147-1150 to say idleness now counts from request completion. This is observability-only: /health still never stamps, so the watchdog's poll cannot keep the VM alive.

**Tests to run:** `cd backend && cargo build --release && node test-backend.mjs`, `node test-worker-pool.mjs`

**Invariants — do not break:** Do NOT touch the compute paths, wire formats, or anything affecting JS↔Rust energy/passes bit-parity (test-backend.mjs enforces it). /health must continue to NOT stamp LAST_COMPUTE_AT (otherwise the watchdog's own poll would keep the VM alive forever — the comment at main.rs:60-61 is load-bearing). The new binary must be republished to wherever BACKEND_BINARY_URL points (or the VM disk cache invalidated) to take effect on the VM — flag this to the user.

*(Fix approach independently re-verified as sound.)*

---

## LANE-CLOUD — Cloud orchestrator + VM scripts

**Files:** `orchestrator/main.py, orchestrator/deploy-orchestrator.sh, orchestrator/Dockerfile, orchestrator/requirements.txt, vm/startup-script.sh, vm/bake-instance.sh`

### [high] In-VM cost backstops (idle watchdog + uptime cap) are installed last by a set -e startup script; a first-boot failure leaves a 96-vCPU SPOT VM running forever with no platform-level cap and no reaper that touches RUNNING instances

**Where:** `vm/startup-script.sh:17`  
**Difficulty:** small  
**Fix touches:** `vm/startup-script.sh`, `orchestrator/main.py`, `vm/bake-instance.sh`

**Problem.** vm/startup-script.sh runs with `set -euo pipefail` and only writes+enables the idle-watchdog timer (which also enforces the MAX_UPTIME_S=7200s hard cap) at steps 4-5, AFTER a chain of network-dependent steps: `apt-get update/install` (lines 50-52), the Caddy download (lines 146-148), and on a fresh disk the rustup install + git clone + cargo build (lines 79-90, ~10 min per the script's own comment). Any transient failure in those steps aborts the script before `systemctl enable --now simujoules-watchdog.timer` (line 320) runs. On the FIRST boot of an orchestrator-created instance (orchestrator/main.py `_gcp_create_instance`, e.g. after the 30-day reaper deleted the baked VM) no watchdog from a previous boot exists, so the VM keeps RUNNING with zero cost backstop: the orchestrator has no sweeper, `/cloud/reap` explicitly refuses non-STOPPED instances (main.py lines 684-685 return reason "not-stopped"), and the only stop is the browser's best-effort boot-timeout `stopCloudVm` — which never fires if the tab closed. A c4-standard-96 SPOT VM bills continuously (order of $700+/month) until someone notices. v49's C22 fix (deploy.sh no longer deletes gs://simujaules/vm/startup-script.sh) removed only ONE trigger of this class; a transient apt/curl/git/cargo failure still reproduces it. Additionally, `_gcp_create_instance` never sets a platform-enforced run-duration limit and omits the `max-uptime-s` metadata key that bake-instance.sh passes (line 163), so orchestrator-created VMs cannot even configure the in-guest cap.

**Evidence.**
```
startup-script.sh:17 `set -euo pipefail`; :50-52 `apt-get update -y / apt-get install -y ...` ... watchdog only at :235-321 ending `systemctl enable --now simujoules-watchdog.timer`; main.py:684-685 `if state != STATE_STOPPED: return jsonify({"deleted": False, ..., "reason": "not-stopped"})`; main.py:297-307 metadata items dict has no "max-uptime-s" and `inst.scheduling` (lines 258-263) sets no max_run_duration.
```

**Fix approach.** Two independent layers. (1) vm/startup-script.sh: move the whole watchdog block — the `MAX_UPTIME_S="$(metadata max-uptime-s)"` read (line 279), the WATCHDOG_PATH heredoc (lines 234-276), the simujoules-watchdog.service/.timer heredocs (lines 281-312) — plus a `systemctl daemon-reload && systemctl enable --now simujoules-watchdog.timer` to immediately after the metadata-helper section (after line ~45), BEFORE '--- 1) Dependências'. The watchdog needs only bash/curl/python3 (all present on GCE debian-12 images; it already treats an unreadable /health as busy), so early install is safe and the uptime cap then survives any later step failing. Keep the (now redundant) enable in step 5 or delete it. (2) Platform cap: in orchestrator/main.py `_gcp_create_instance`, inside the `if PROVISIONING_MODEL == "SPOT":` branch add `sched.max_run_duration = compute_v1.Duration(seconds=_env_int("MAX_RUN_DURATION_S", 14400))` (google-cloud-compute supports Scheduling.max_run_duration; it requires instance_termination_action, already "STOP"), and add `"max-uptime-s": str(_env_int("MAX_UPTIME_S_META", 7200))` — or simply `"max-uptime-s": "7200"` — to the metadata `items` dict for parity with bake-instance.sh. In vm/bake-instance.sh add `--max-run-duration=${MAX_RUN_DURATION:-4h}` next to `--instance-termination-action=STOP` in the SPOT branch (line 149). GCP then stops the VM even if the startup script never executed.

**Tests to run:** `bash -n vm/startup-script.sh`, `bash -n vm/bake-instance.sh`, `python3 -m py_compile orchestrator/main.py`, `DRY_RUN=1 CLOUD_AUTH_TOKEN=x REAP_TOKEN=y python3 orchestrator/main.py (smoke: curl -X POST -H 'Authorization: Bearer x' localhost:8079/cloud/start)`

**Invariants — do not break:** Keep the inline watchdog heredoc in startup-script.sh in logic-parity with vm/idle-watchdog.sh (documented parity rule in both files). Keep instance_termination_action=STOP (a guest `shutdown -h` must STOP, not delete). DRY_RUN mode must still run without the google-cloud-compute package (max_run_duration goes inside the lazy-imported `_gcp_create_instance` only). Do not touch the compute engines or wire formats. This is a re-boot-visible change: republish gs://simujaules/vm/startup-script.sh out-of-band (orchestrator/README.md documents the gsutil cp) — flag that to the user rather than doing it silently.

*(Fix approach independently re-verified as sound.)*

---

### [medium] Default orchestrator deploy leaves BACKEND_BINARY_URL empty, so a VM recreated by /cloud/start compiles Rust from source (~10 min) while the client stops it at the 8-min boot deadline mid-build — each retry re-bills and may never converge

**Where:** `orchestrator/deploy-orchestrator.sh:44`  
**Difficulty:** small  
**Fix touches:** `orchestrator/deploy-orchestrator.sh`, `orchestrator/README.md`, `app.js`

**Problem.** deploy-orchestrator.sh's ENV_VARS block (lines 36-44) never sets BACKEND_BINARY_URL, and orchestrator/main.py defaults it to "" (line 114), so any instance the orchestrator creates (first-ever use, after /cloud/delete, or after the 30-day reaper deletes the baked VM) gets empty `backend-binary-url` metadata and vm/startup-script.sh takes the build-from-source path: fresh rustup + git clone + cargo build --release, which the script's own comment (line 63) sizes at ~10 min. The app's create-path deadline is `Math.max(CLOUD_BOOT_TIMEOUT_MS, etaS*2*1000)` = max(5 min, 2×240 s) = 8 min (app.js line 7914 with etaSeconds=240 from main.py line 503), and on boot_failed the client explicitly stops the VM (app.js line 6587 `if (bootFailed) stopCloudVm(backendUrl);`) — mid-build, before the binary is cached to /opt/simujoules (startup-script line 90 `cp` runs only after the build). The next /cloud/start boots the same disk, finds no cached binary, wipes ~/.rustup and the clone, and repeats the full build, getting stopped again: every attempt bills ~8 min of a 96-vCPU SPOT VM and cloud compute never becomes usable. The bake path documents BACKEND_BINARY_URL (vm/README.md line 53) but the orchestrator deploy — the path that actually recreates VMs unattended — omits it.

**Evidence.**
```
deploy-orchestrator.sh:36-44 ENV_VARS lists GCP_PROJECT/GCP_ZONE/INSTANCE_NAME/DATA_HOST/APP_ORIGIN/FIREWALL_RULE/CF_ZONE_ID/STARTUP_SCRIPT_URL/REAP_IDLE_DAYS — no BACKEND_BINARY_URL; main.py:114 `BACKEND_BINARY_URL = _env("BACKEND_BINARY_URL", "")`; startup-script.sh:63 'cada start recompilaria (~10 min)'; app.js:7914 `const deadline = performance.now() + Math.max(CLOUD_BOOT_TIMEOUT_MS, etaS * 2 * 1000);` and :6587 `if (bootFailed) stopCloudVm(backendUrl);`.
```

**Fix approach.** (1) In deploy-orchestrator.sh add `ENV_VARS="${ENV_VARS},BACKEND_BINARY_URL=${BACKEND_BINARY_URL:-https://storage.googleapis.com/simujaules/vm/simujoules-backend}"` and document (in the script header + orchestrator/README.md) publishing the release binary out-of-band: `gsutil cp backend/target/release/simujoules-backend gs://simujaules/vm/simujoules-backend` (the bucket already hosts vm/startup-script.sh; startup-script.sh curls the URL, so use the public https storage.googleapis.com form). (2) Defense-in-depth in app.js ensureCloudVm: for the create path (etaS >= 180) widen the deadline so one source build can complete and cache even without a binary URL — change line 7914 to `const deadline = performance.now() + Math.max(CLOUD_BOOT_TIMEOUT_MS, etaS * (etaS >= 180 ? 5 : 2) * 1000);` (create → 20 min, warm start unchanged).

**Tests to run:** `bash -n orchestrator/deploy-orchestrator.sh`, `Browser smoke of Cloud mode against DRY_RUN orchestrator (deadline change must not break the normal boot path)`, `node test-worker-pool.mjs (regression)`

**Invariants — do not break:** Do not auto-run gsutil/gcloud — provide commands to the user (workspace rule: cloud mutations are the user's). Never put the binary in deploy.sh's rsynced site payload; keep it under the vm/ prefix which deploy.sh excludes from --delete (v49 C22 fix). sw.js VERSION + changelog trio if the app.js change ships.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: The two-part fix direction (forward BACKEND_BINARY_URL through deploy-orchestrator.sh's ENV_VARS; widen the app.js create-path deadline as defense-in-depth) is correct in spirit, but the specific approach as written introduces a new failure mode and is missing a required file. (1) Do NOT hardcode a default value `${BACKEND_BINARY_URL:-https://storage.googleapis.com/simujaules/vm/simujoules-backend}` in deploy-orchestrator.sh. vm/startup-script.sh:55-59 does `curl -fSL "$BACKEND_BINARY_URL" -o "$BIN_PATH"` under `set -euo pipefail` (script header line 17) with no fallback: if that GCS object hasn't actually been published (true for anyone following remote-cloud-setup.md's B6 literally, since the publish step is only an optional "Tip", never run by deploy-orchestrator.sh itself), curl's -f flag returns non-zero on the 404 and `set -e` aborts the ENTIRE startup-script within seconds — Caddy and the backend service (steps 3-5) never get configured at all. This is strictly worse than today's bug: today a real (if slow) build eventually produces a working VM given enough time; with this default, every create silently 404s and never becomes healthy regardless of the client-side deadline, because the widened app.js timeout (part 2) buys zero benefit against a script that dies in seconds. Fix: either (a) forward only a caller-supplied value (`ENV_VARS="${ENV_VARS},BACKEND_BINARY_URL=${BACKEND_BINARY_URL:-}"`, matching bake-instance.sh's own pattern) plus a printed warning/README callout urging the one-time `gsutil cp backend/target/release/simujoules-backend gs://simujaules/vm/simujoules-backend`, and/or (b) make vm/startup-script.sh's download step fail-open instead of fail-fast, e.g. `if [[ -n "$BACKEND_BINARY_URL" ]] && curl -fSL "$BACKEND_BINARY_URL" -o "$BIN_PATH"; then chmod +x "$BIN_PATH"; elif [[ -x "$BIN_PATH" ]]; then ...; else <build from source>; fi` so a missing/stale/mistyped URL degrades to the existing (slow but functional) source-build path rather than hard-aborting. Option (b) is the one that actually closes the finding's non-convergence risk unconditionally and should be added to filesTouched — vm/startup-script.sh is currently missing from the fix's file list even though its fail-fast behavior determines whether the ENV_VARS change is safe. (2) Minor citation fix: the "~10 min" comment quoted in the finding's evidence is at vm/startup-script.sh line 62, not 63 (line 63 is the following sentence about the vestigial "HEALTH_WAIT_S do orquestrador" reference) — correct the line number when handing to the fix-agent. (3) The app.js deadline widening itself (etaS*(etaS>=180?5:2)*1000, create→20 min, warm start unchanged) is sound as pure defense-in-depth and doesn't conflict with any stated invariant (CLOUD_BOOT_TIMEOUT_MS has a single use site, the watchdog's default MAX_UPTIME_S of 7200s gives ample headroom, and the change doesn't touch the etaS-derived hint text so there's no i18n drift) — keep it, but note it only helps once (1) and (2) above are addressed; on its own it does not fix the finding because a 404'd curl aborts long before any deadline is reached.

---

### [medium] Orchestrator trusts the client-forgeable FIRST X-Forwarded-For entry for the VM firewall /32, and concurrent token users repoint the firewall at each other

**Where:** `orchestrator/main.py:590`  
**Difficulty:** small  
**Fix touches:** `orchestrator/main.py`, `orchestrator/README.md`

**Problem.** The Cloud Run orchestrator (orchestrator/main.py) tightens a GCP firewall rule so only 'the requesting browser's /32' can reach the compute VM's data port 443. _client_ip() (lines 586-591) takes the FIRST comma-separated entry of X-Forwarded-For. On Cloud Run the platform APPENDS the true immediate-client IP as the LAST entry; everything to the LEFT is whatever the client itself sent. So any caller holding the shared Bearer token can send 'X-Forwarded-For: 203.0.113.7' and _gcp_tighten_firewall() (lines 316-343) will patch the rule's source_ranges to that arbitrary /32 — opening the 96-vCPU VM's data plane to an IP the caller chose, or locking the legitimate user out (DoS). Separately, _gcp_tighten_firewall REPLACES source_ranges with a single /32 (line 331 'rule.source_ranges = [f"{client_ip}/32"]'), and /cloud/status re-tightens on every poll (line 624), so two legitimate token users polling concurrently continually repoint the firewall at each other — each poll cuts the other user's compute connection. Also, an IPv6 client IP produces '<ipv6>/32', a colossal IPv6 block, not a host route.

**Evidence.**
```
def _client_ip():
    """IP real do navegador. No Cloud Run vem como 1º item do X-Forwarded-For."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
...
        rule.source_ranges = [f"{client_ip}/32"]
```

**Fix approach.** (1) In _client_ip() (orchestrator/main.py:586-591) parse from the RIGHT: ip = xff.split(",")[-1].strip() — on Cloud Run (direct or via a DNS-only CNAME/domain-mapping, which is how orch.simujaules.pedalhidrografi.co is set up per deploy-orchestrator.sh:71) the platform appends the true client IP last. Validate with `import ipaddress; parsed = ipaddress.ip_address(ip)`; on ValueError or parsed.version != 4 return "" (the tighten function already no-ops on empty, line 322-323) and log a warning. Update the wrong comment here and in orchestrator/README.md:37-38 ('o 1º item é o IP real do cliente' → last item). (2) In _gcp_tighten_firewall(client_ip) (lines 316-343), stop replacing the rule with a single /32: keep a module-level dict _recent_client_ips (ip -> time.time()), prune entries older than 2 hours, cap at 8 entries (if full, drop the oldest); on each call add client_ip, then MERGE with the rule's current source_ranges read at line 330 (keep only entries still in _recent_client_ips, plus the new one, so stale IPs age out) and patch source_ranges to the sorted union. Replace the last_ip attribute cache (line 324) with a comparison against the computed range-set so unchanged sets skip the API call. (3) In ensure_up() (line 493), when the VM is being freshly created/started from ABSENT/STOPPED, reset _recent_client_ips to {client_ip: now} so a new session starts with a tight rule.

**Tests to run:** `python3 -m py_compile orchestrator/main.py`, `DRY_RUN mode manual test: run the Flask app locally with DRY_RUN set, POST /cloud/start with forged 'X-Forwarded-For: 1.2.3.4, 5.6.7.8' plus the Bearer token, and assert the logged tighten target is 5.6.7.8 (the last entry), not 1.2.3.4`

**Invariants — do not break:** Keep fail-closed auth (_require(CLOUD_AUTH_TOKEN)) untouched; keep _gcp_tighten_firewall best-effort (log-and-continue on exceptions, lines 342-343); comments in Portuguese per house style; do not change the rule name, port, or the tcp:DATA_PORT allowed spec; the orchestrator may run multiple Cloud Run instances, so the in-memory recent-IP set must merge with the rule's live source_ranges rather than assume it is the only writer.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: (a) Fix the test plan: DRY_RUN mode skips `_gcp_tighten_firewall` entirely (guarded by `if not DRY_RUN:` at main.py:515-516 and :623-624), so the described curl/DRY_RUN test can never observe a "tighten target" log line. Replace it with a direct unit test of `_client_ip()`, e.g. `with main.app.test_request_context(headers={'X-Forwarded-For': '1.2.3.4, 5.6.7.8'}): assert main._client_ip() == '5.6.7.8'`, plus edge cases (single-entry XFF, missing XFF falling back to `request.remote_addr`, an IPv6 last-entry returning `''`). (b) Persist the per-IP last-seen timestamps outside process memory so `_recent_client_ips` survives an orchestrator cold start — Cloud Run scales this service to zero between sessions by design (`--max-instances=1 --min-instances=0`; app.js's keepalive ping is stopped as soon as each compute run ends, even in "keep warm" mode), so a purely in-memory aging/eviction scheme will, on the very next call after any idle gap, treat every previously-whitelisted IP as unknown and drop it — reproducing the original bug on a longer timescale. Simplest durable option: store `{ip: last_seen_epoch}` as JSON in the firewall rule's own `description` field (read in the same `firewalls.get()` call already made at line 330, written in the same `firewalls.patch()` call at line 336-338) so prune/merge has a source of truth independent of which process/instance handles the request. (c) Minor: with gunicorn `--threads 8` (Dockerfile), concurrent requests share the module-level dict without a lock — add a `threading.Lock` around the read-prune-merge-patch sequence in `_gcp_tighten_firewall` to avoid two threads issuing overlapping `firewalls.patch()` calls against stale reads of `_recent_client_ips`/`rule.source_ranges`.

---

### [medium] No lease/refcount on /cloud/stop: one token user's default stop-after-run halts the VM mid-compute of a second concurrent user

**Where:** `orchestrator/main.py:643`  
**Difficulty:** medium  
**Fix touches:** `orchestrator/main.py`, `app.js`, `orchestrator/README.md`

**Problem.** The orchestrator is deliberately stateless: /cloud/keepalive is a documented no-op (main.py 635-640) and /cloud/stop (643-648) stops the instance unconditionally. With two browsers sharing the CLOUD_AUTH_TOKEN (the intended small-collective model), browser A finishes its run first and its default stop-after-each-run posts /cloud/stop while browser B's /density is still executing on the VM — B's fetch dies and the app falls back to the browser pool ('VM da nuvem interrompida'), silently recomputing a huge DEM locally. This is distinct from the KNOWN-OPEN firewall /32 repointing item (that breaks reachability; this destroys an in-flight computation even with reachability intact). No money is lost (the stop saves money), but a paid multi-minute compute is discarded.

**Evidence.**
```
main.py:635-640 `def cloud_keepalive(): """No-op (compat). O custo é contido pelo idle-watchdog DA VM, não por lease."""` and :643-648 `def cloud_stop(): ... return jsonify({"state": stop_instance()})` — no check for other active users.
```

**Fix approach.** Re-purpose the existing keepalive traffic into an in-memory lease registry (safe: Cloud Run runs --max-instances=1, gunicorn --workers 1). In main.py add module state `LEASES = {}` guarded by a `threading.Lock()`; the app sends a stable per-tab id — in app.js generate `state.cloud.clientId = crypto.randomUUID()` once and send it as header `X-Simu-Client` from startCloudKeepalive and stopCloudVm; add `X-Simu-Client` to the orchestrator's Access-Control-Allow-Headers (main.py line 575). /cloud/keepalive records `LEASES[client_id] = time.time() + 180`; /cloud/stop prunes expired entries and, if any OTHER client's lease is unexpired, returns `jsonify({"state": get_instance()[0], "skipped": "active-lease"})` without stopping (the in-VM idle watchdog remains the cost backstop when that other client vanishes). Requests without the header keep today's unconditional-stop behaviour (backwards compatible). Update the 'praticamente SEM estado' note in main.py's docstring and orchestrator/README.md.

**Tests to run:** `python3 -m py_compile orchestrator/main.py`, `DRY_RUN smoke: two curl clients with different X-Simu-Client, one keepalives, the other's /cloud/stop must return skipped:active-lease; after 180 s it must stop`, `Browser smoke of a full cloud run against DRY_RUN orchestrator`

**Invariants — do not break:** Keep all existing response fields (state/etaSeconds/dataUrl/leaseExpiresAt) so older clients keep working; keep fail-closed auth on every /cloud/* route; the in-VM watchdog must remain the ultimate cost backstop (a lease must never keep a VM alive — only defer an explicit stop by ≤180 s of missing keepalives). sw.js VERSION + changelog trio for the app.js change.

*(Fix approach independently re-verified as sound.)*

---

### [low] bake-instance.sh accepts an empty CLOUD_AUTH_TOKEN, producing a VM whose Caddy auth matcher compares against 'Bearer ' behind a default 0.0.0.0/0 firewall — auth then hinges on header-whitespace parsing trivia

**Where:** `vm/bake-instance.sh:57`  
**Difficulty:** trivial  
**Fix touches:** `vm/bake-instance.sh`, `vm/startup-script.sh`

**Problem.** CLOUD_AUTH_TOKEN defaults to empty in bake-instance.sh (line 57) and is passed straight into instance metadata (line 163); FW_SOURCE_RANGE defaults to 0.0.0.0/0 (line 80). startup-script.sh then writes the Caddy matcher `@unauth not header Authorization "Bearer {env.CLOUD_AUTH_TOKEN}"` with an empty env var, i.e. the expected header value becomes 'Bearer ' (trailing space). Whether any request can match that depends on Caddy's OWS trimming of header values — undefined-by-inspection behaviour guarding a 96-vCPU compute plane that the placeholder firewall exposes to the whole internet until the orchestrator's first tighten. Most likely everything 401s (accidentally fail-closed, and the deployment is just broken), but the auth posture of a billable VM should not depend on whitespace parsing. The orchestrator side is properly fail-closed (_require refuses empty tokens); the manual bake path has no equivalent guard.

**Evidence.**
```
bake-instance.sh:57 `CLOUD_AUTH_TOKEN="${CLOUD_AUTH_TOKEN:-}"   # token compartilhado app↔Caddy` and :80 `FW_SOURCE_RANGE="${FW_SOURCE_RANGE:-0.0.0.0/0}"`; startup-script.sh:177 `@unauth not header Authorization "Bearer {env.CLOUD_AUTH_TOKEN}"`.
```

**Fix approach.** (1) In bake-instance.sh, after argument parsing (~line 97), refuse to bake without a token: `if [[ "$DRY_RUN" -eq 0 && -z "$CLOUD_AUTH_TOKEN" ]]; then echo "ERRO: defina CLOUD_AUTH_TOKEN (o plano de dados ficaria sem auth definida)" >&2; exit 1; fi`. (2) Make the VM fail closed regardless of caller: in vm/startup-script.sh, before writing the Caddyfile, add `if [[ -z "$CLOUD_AUTH_TOKEN" ]]; then echo "-- auth-token vazio: plano de dados NEGADO (fail-closed) --"; fi` and when empty write a Caddyfile whose main handle is just `respond "unauthorized" 401` (no reverse_proxy), so an empty-token VM serves nothing.

**Tests to run:** `bash -n vm/bake-instance.sh vm/startup-script.sh`, `CLOUD_AUTH_TOKEN= ./vm/bake-instance.sh --dry-run (must now error out)`

**Invariants — do not break:** Keep the orchestrator-created path working: _gcp_create_instance always passes the (non-empty, Secret-Manager-sourced) token, so the fail-closed branch must only trigger on genuinely empty metadata. Error messages in these operator scripts are Portuguese (house style). Republish gs://simujaules/vm/startup-script.sh after changing it (user-run command, not automatic).

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: The fix's two components are good ideas but the spec has one concrete bug and one underspecified detail a fix-agent should be told about:

1. BUG — dry-run/test mismatch: the proposed guard is `if [[ "$DRY_RUN" -eq 0 && -z "$CLOUD_AUTH_TOKEN" ]]; then ...; exit 1; fi`, i.e. it only fires when DRY_RUN is 0 (a REAL run). But the spec's own `testsToRun` says `CLOUD_AUTH_TOKEN= ./vm/bake-instance.sh --dry-run (must now error out)` — under `--dry-run`, DRY_RUN is 1, so with the guard as written this test would NOT error out; the test contradicts the code it's meant to validate. Since a real (non-dry-run) invocation is a billable, credential-requiring `gcloud` call and can't safely be used as an automated regression test, the guard should instead fire unconditionally (drop the `"$DRY_RUN" -eq 0 &&` clause) so `--dry-run` also surfaces the missing-token error — this is also the only way to actually exercise the fix by hand without spending money, and it matches the stated test. Net effect: `--dry-run` becomes slightly less convenient (you must export a placeholder CLOUD_AUTH_TOKEN just to preview), which is an acceptable, intentional trade-off, but the fix-agent must be told to make this change deliberately rather than leave the `$DRY_RUN -eq 0` condition as literally quoted in the spec.

2. UNDERSPECIFIED — startup-script.sh fail-closed branch: the spec says 'write a Caddyfile whose main handle is just `respond "unauthorized" 401` (no reverse_proxy)' but doesn't say what to do with the existing `tls { dns cloudflare {env.CF_API_TOKEN} }` block or the CORS-preflight `@preflight` handle in that branch. Recommend: keep the top-level `{DATA_HOST}:{DATA_PORT} { tls {...} ... }` wrapper (so cert issuance still proceeds normally and doesn't retry-storm Let's Encrypt/DNS-01), but replace the ENTIRE inner routing body (both `@preflight` and the real proxy handle) with a single unconditional `respond "unauthorized" 401` — don't special-case OPTIONS in the fail-closed branch, since there's no legitimate reason to give CORS preflight a pass when there's no valid token to protect anything behind it. Implement as a bash-level branch (picking between two heredoc bodies, or a post-write override) keyed on `[[ -z "$CLOUD_AUTH_TOKEN" ]]`, placed before line 155's `cat > /etc/caddy/Caddyfile`.

3. Confirmed accurate and worth keeping in the fix as-is: the invariant note to republish `gs://simujaules/vm/startup-script.sh` is correct and necessary — orchestrator/main.py:116 (`STARTUP_SCRIPT_URL = _env("STARTUP_SCRIPT_URL", "gs://simujaules/vm/startup-script.sh")`) means the orchestrator-driven instance-creation path (`_gcp_create_instance`, main.py:241-313) reads the startup-script from that GCS object, not from the local repo file, so editing only the local `vm/startup-script.sh` would leave orchestrator-created VMs running the old (unguarded) version until someone re-uploads it.

4. Minor, non-blocking behavior change to flag to the user: with the corrected (unconditional) guard, re-running `bake-instance.sh` (no `--dry-run`) with `CLOUD_AUTH_TOKEN` unset now aborts even when the firewall rule and instance already exist and the run would otherwise no-op through the existing idempotency checks (lines 124-136, 141-165). This is an acceptable, probably desirable stricter default, but should be called out in the commit message / operator-facing echo text so it isn't mistaken for a regression.

---

### [low] Concurrent /cloud/start race on an ABSENT instance: the losing insert surfaces as a 500 and that browser silently abandons cloud for the run

**Where:** `orchestrator/main.py:500`  
**Difficulty:** trivial  
**Fix touches:** `orchestrator/main.py`

**Problem.** ensure_up() does an unguarded read-then-act: `state == STATE_ABSENT → _gcp_create_instance()`. gunicorn runs 1 worker × 8 threads, so two /cloud/start requests (two tabs/users, or a user retry racing the first call's 15 s timeout) can both observe ABSENT and both call instances.insert; the second raises google.api_core.exceptions.Conflict (409), which propagates as an uncaught exception → Flask 500 → the client's ensureCloudVm maps any non-ok start to reason orch_unreachable and falls back to the browser pool, even though the VM is in fact being created and would have been ready. No duplicate VM or money loss (single fixed INSTANCE_NAME), just a spurious hard failure on a benign race. The same unguarded pattern makes `_gcp_start_instance()` on a REPAIRING instance (mapped to STATE_ERROR, line 504) raise and 500 as well.

**Evidence.**
```
main.py:498-509 `if state == STATE_ABSENT:\n        if DRY_RUN:\n            _dry_create()\n        else:\n            _gcp_create_instance()\n        eta = 240\n    elif state in (STATE_STOPPED, STATE_ERROR):\n        ...\n            _gcp_start_instance()` — no exception handling around either GCP call.
```

**Fix approach.** In ensure_up(), wrap the two mutating calls: `try: _gcp_create_instance()\nexcept Exception as e:  # google.api_core.exceptions.Conflict/AlreadyExists → someone else created it\n    from google.api_core.exceptions import AlreadyExists, Conflict\n    if not isinstance(e, (AlreadyExists, Conflict)): raise\n    log.info("create raced — instância já existe")` (import inside the except to preserve DRY_RUN's lazy-import property), and similarly wrap `_gcp_start_instance()` treating a 400/409 ('not in a startable state') as in-transition: log a warning and continue (the returned state/eta from the trailing get_instance() reflects reality and the client's poll loop takes over).

**Tests to run:** `python3 -m py_compile orchestrator/main.py`, `DRY_RUN=1 smoke run (DRY_RUN path must be untouched and still run without google-cloud-compute installed)`

**Invariants — do not break:** Keep google.cloud imports lazy (DRY_RUN must work without the package — main.py docstring line 37). Do not swallow non-conflict GCP errors (auth/quota failures must still surface as 500 so the client falls back).

*(Fix approach independently re-verified as sound.)*

---

### [info] Orchestrator image is unpinned: python:3.12-slim by tag and a fully unversioned requirements.txt make the paid-VM control plane non-reproducible

**Where:** `orchestrator/Dockerfile:5`  
**Difficulty:** trivial  
**Fix touches:** `orchestrator/Dockerfile`, `orchestrator/requirements.txt`

**Problem.** orchestrator/Dockerfile builds `FROM python:3.12-slim` (mutable tag, no digest) and requirements.txt is `flask / gunicorn / requests / google-cloud-compute` with no version constraints. Every `gcloud run deploy --source` rebuild resolves whatever is latest at that moment, so a redeploy months later can silently pick up a breaking flask/google-cloud-compute major (e.g. a Scheduling field rename would break _gcp_create_instance at runtime, leaving cloud compute down until debugged) or a compromised release — on the one service holding the tokens that start billable 96-vCPU VMs and edit the pedalhidrografi.co DNS zone. Everything else in the repo pins dependencies (CDN scripts carry SRI hashes; Cargo.lock pins the backend).

**Evidence.**
```
Dockerfile:5 `FROM python:3.12-slim`; requirements.txt: `flask\ngunicorn\nrequests\ngoogle-cloud-compute` (no versions).
```

**Fix approach.** Pin requirements.txt to the currently-deployed working set with compatible-release bounds, e.g. `flask~=3.0`, `gunicorn~=23.0`, `requests~=2.32`, `google-cloud-compute~=1.19` (verify against `pip freeze` in the current image or a fresh local venv that passes the DRY_RUN smoke test), and pin the base image by digest: `FROM python:3.12-slim@sha256:<digest of current python:3.12-slim>` with a comment on how to refresh it.

**Tests to run:** `python3 -m venv /tmp/venv && pip install -r orchestrator/requirements.txt (resolves cleanly)`, `DRY_RUN=1 CLOUD_AUTH_TOKEN=x REAP_TOKEN=y python3 orchestrator/main.py smoke (start/status/stop/reap against the fake state machine)`

**Invariants — do not break:** DRY_RUN must keep running WITHOUT google-cloud-compute installed (lazy import — don't move imports to module top while touching this). Do not change the gunicorn CMD (--workers 1 is the house convention; --threads 8 is load-bearing for /status during a blocking /start).

*(Fix approach independently re-verified as sound.)*

---

## LANE-DOCS-MISC — sw.js + index.html (structural) + provenance docs

**Files:** `sw.js, index.html (CSP/focus-trap/changelog-language only), dem/vector/README.md (new)`

### [low] No Content-Security-Policy in index.html and the Google Fonts stylesheet is the one CDN resource without SRI/crossorigin (fonts absent offline)

**Where:** `index.html:15`  
**Difficulty:** medium  
**Fix touches:** `index.html`

**Problem.** index.html ships no CSP (grep for http-equiv/Content-Security-Policy finds nothing), so any injected script — the app has already had one crafted-file XSS (v48 review C11, fixed) and interpolates many user-derived strings into innerHTML — runs unconstrained. Additionally the fonts.googleapis.com stylesheet (index.html:15) is the only CDN resource without integrity/crossorigin: it cannot be SRI-pinned (Google serves per-UA CSS) and, being non-CORS, is never runtime-cached by sw.js, so fonts silently disappear offline. External surface enumerated for the policy: scripts from unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com (all SRI-pinned); sql.js fetches sql-wasm.wasm from cdnjs (app.js:2683) and compiles WASM; two inline <script> blocks (index.html:1226 drawer toggle, index.html:1439 SW registration) plus a non-executing JSON-LD block (index.html:39); inline <style> and many style= attributes; same-origin Workers (app.js:991 WORKER_URL="./energy-worker.js", importScripts graph-engine.js); canvas toDataURL data: images for Leaflet overlays; tile hosts (tile.openstreetmap.org, *.basemaps.cartocdn.com, server.arcgisonline.com, telhas.pedalhidrografi.co); fetch targets overpass-api.de, storage.googleapis.com, simujaules.pedalhidrografi.co, orch.simujaules.pedalhidrografi.co, compute.simujaules.pedalhidrografi.co, telhas.pedalhidrografi.co/fabdem/, plus the user-configurable native backend (default http://127.0.0.1:8077, app.js:1945).

**Evidence.**
```
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" />  (no integrity/crossorigin; and no <meta http-equiv="Content-Security-Policy"> anywhere in index.html)
```

**Fix approach.** Add a CSP meta tag to index.html <head> reflecting what the app actually loads (verified live, not guessed): script-src/style-src need cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com (CDN libs), fonts.googleapis.com (stylesheet); font-src needs fonts.gstatic.com; img-src needs the basemap tile hosts ({s}.tile.openstreetmap.org, {s}.basemaps.cartocdn.com, server.arcgisonline.com, telhas.pedalhidrografi.co) plus blob:/data: for canvas-rendered overlays and exports; connect-src needs overpass-api.de, storage.googleapis.com, simujaules.pedalhidrografi.co, orch.simujaules.pedalhidrografi.co, telhas.pedalhidrografi.co, AND http://127.0.0.1:* / http://localhost:* (the optional local native-backend checkbox posts to a user-supplied 127.0.0.1:8077-style URL by default) plus a wildcard allowance or the user's own custom backend URL if self-hosted elsewhere -- a strict connect-src would break that documented feature, so either omit connect-src restriction for that host class or document the limitation. worker-src/child-src need 'self' (energy-worker.js, graph-engine.js). Do NOT attempt to SRI-pin the Google Fonts stylesheet itself -- it is dynanumc dynamically generated per user-agent (different @font-face src per browser), so a fixed SRI hash is not applicable there; that is a real, accepted exception to the SRI convention, not a bug to silently drop -- add a one-line HTML comment saying so next to the fonts <link> instead of touching it. There is no boot.js file and no fonts/ directory in this repo -- ignore any prior suggestion to touch them.

**Tests to run:** `Browser end-to-end with DevTools console open watching for CSP violations: load hosted example DEM (storage/simujaules fetch), load .gpkg (sql.js WASM from cdnjs), OSM streets + bridges + water pulls (overpass-api.de), census refs (flatgeobuf Range fetch to storage.googleapis.com), FABDEM load (telhas), all 4 basemap choices + rmsampa-v2 tiles, run compute (worker), graph mode (importScripts), export bundle/rendered (blob: downloads), localhost backend health check, offline reload with fonts visible`, `node test-worker-pool.mjs (unaffected sanity)`

**Invariants — do not break:** cache.addAll is atomic — every new PRECACHE_URLS entry MUST also be in deploy.sh's staged list or the SW install 404-breaks for all users; keep SRI integrity+crossorigin on every remaining CDN tag (crossorigin is also what lets sw.js runtime-cache them); no build step — boot.js is plain vendored JS; sw.js VERSION bump + changelog trio; UI text through STRINGS/t().

*(Fix approach independently re-verified as sound.)*

---

### [low] sw.js 30 MB runtime-cache cap is bypassed by responses without a Content-Length header (chunked/compressed CDN responses cache unbounded)

**Where:** `sw.js:424`  
**Difficulty:** small  
**Fix touches:** `sw.js`, `CHANGELOG.md`, `index.html`

**Problem.** withinRuntimeCap (sw.js:423-426) returns TRUE when Content-Length is absent or unparseable, so any chunked/Content-Encoding response with no Content-Length — common through Cloudflare/CDN compression — is cached into RUNTIME regardless of size, re-inflating exactly the bloat + full background re-download problem the v49 cap (C24) was added to stop. The .tif/.gpkg extension exemption (sw.js:488) covers the known big files but not, e.g., large JSON (Overpass responses are POST so exempt, but any big GET without Content-Length qualifies). The other half of the v49 residual — 'precache cache:"reload" only takes effect one update cycle after it ships' — needs NO action: the install handler that runs cache.addAll is the NEW service worker's own code, so the reload option applied at the very v48→v49 update that shipped it, and the transition is in the past either way.

**Evidence.**
```
function withinRuntimeCap(res) {
  const len = parseInt(res.headers.get("content-length") || "", 10);
  return !(Number.isFinite(len) && len > MAX_RUNTIME_BYTES);
}
```

**Fix approach.** Replace the two `withinRuntimeCap(res)` + `caches.open(RUNTIME).then((c) => c.put(req, copy))` call sites in handle() (sw.js:535-537 and 546-551) with one async helper `putIfWithinCap(req, res)` (res = the already-made clone): if Content-Length parses, keep today's fast path (skip if > MAX_RUNTIME_BYTES, else cache.put). If absent: if (!res.body) { cache.put directly } else read res.body via getReader(), accumulating chunks and a byte count; if the count exceeds MAX_RUNTIME_BYTES, reader.cancel() and skip caching; else rebuild `new Response(new Blob(chunks), { status: res.status, statusText: res.statusText, headers: h })` where h = new Headers(res.headers) with content-encoding, content-length and transfer-encoding DELETED (the streamed bytes are the DECODED body — keeping content-encoding would corrupt later cache.match reads) and put that. Memory is bounded to ~30 MB + one chunk. Update the comment block at sw.js:416-420 to describe the counted-stream path, bump VERSION to v50 with a changelog line, and move the changelog trio (CHANGELOG.md, index.html <details id="changelog">, sw.js version-history comment).

**Tests to run:** `Browser: DevTools > Application > Cache Storage — load the app, confirm CDN libs still populate simu-runtime-v50; simulate a no-Content-Length response (local dev server with chunked encoding) above and below 30 MB and confirm only the small one is cached; offline reload still serves the shell and libs`, `node test-worker-pool.mjs (sanity, unaffected)`

**Invariants — do not break:** res.clone() must still happen synchronously before the page consumes the body (existing comment, sw.js:521-525); cache writes stay inside event.waitUntil; never cache opaque or non-2xx responses (existing res.ok gate); PRECACHE list and the atomic addAll install are untouched; VERSION bump + changelog trio move together.

*(Fix approach independently re-verified as sound.)*

---

### [low] Help dialog declares aria-modal="true" but manages no focus: no initial focus, no trap, no restore

**Where:** `index.html:1464`  
**Difficulty:** small  
**Fix touches:** `app.js`, `index.html`, `sw.js`, `CHANGELOG.md`

**Problem.** The help modal (index.html:1464: role="dialog" aria-modal="true" aria-labelledby="help-modal-title") is opened/closed purely by toggling a CSS class (app.js:1537-1547 openHelp/closeHelp); no .focus() call exists anywhere in app.js. Per ARIA authoring practice, aria-modal=true requires moving focus into the dialog on open and restoring it on close: as shipped, focus stays on the '?' button, which aria-modal semantically excludes from the accessibility tree — a screen-reader user's focus is stranded in content their AT now treats as hidden, and a keyboard-only user must Tab through the entire sidebar and map controls (the dialog markup sits at the end of body) to reach the close button, with Shift-Tab escaping the dialog freely. Failure scenario: a keyboard/screen-reader user presses the '?' help button — VoiceOver/NVDA announce nothing usable and Tab does not land in the dialog.

**Evidence.**
```
index.html:1464 <div class="modal-backdrop" id="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-modal-title">; app.js:1537-1538 const openHelp = () => helpModal?.classList.add("active"); const closeHelp = () => helpModal?.classList.remove("active"); grep '.focus()' over app.js returns no matches
```

**Fix approach.** In the help wiring at app.js:1531-1547: on openHelp, save document.activeElement and focus the dialog (give the inner .modal div tabindex="-1" and call .focus(), or focus #help-close); on closeHelp, restore focus to the saved element (falling back to #help-btn). Add a keydown handler scoped to the modal that wraps Tab/Shift-Tab within the dialog's focusable elements (the × button and the links in the attribution/changelog sections). Keep the existing Escape/backdrop-click close paths. The layer-order panel (role="region", index.html:1921) is non-modal by design — leave it as is. Bump sw.js VERSION + changelog trio.

**Tests to run:** `Manual browser keyboard-only: Tab to '?', Enter — focus lands in the dialog; Tab cycles within it; Escape returns focus to '?'`, `Manual VoiceOver (macOS) smoke: dialog title announced on open`

**Invariants — do not break:** Do not break the existing close paths (×, backdrop click, Escape at app.js:1545-1547); keep role/aria attributes and data-i18n-aria on the close button; no display-text literals in JS (aria strings via the STRINGS table); bump sw.js VERSION.

*(Fix approach independently re-verified as sound.)*

---

### [low] v48 entry in the help-modal changelog is written in Portuguese inside the block documented (and labelled to users) as English-only

**Where:** `index.html:1576`  
**Difficulty:** trivial  
**Fix touches:** `index.html`, `sw.js`, `CHANGELOG.md`

**Problem.** The collapsed changelog <details id="changelog"> in the help modal carries an HTML comment (index.html:1550-1553) stating 'Entries are English-only by design (technical notes, not UI copy)', and its user-visible summary string help.h.changelog even reads 'Histórico de versões (changelog, em inglês)'. Every entry v49, v47, v46, v45… is English, but the v48 entry (index.html:1576-1586) is entirely in Portuguese ('Comparação de rotas origem→destino. Com "Comparar com cenário sem rede" ligado, o seletor…'). The canonical CHANGELOG.md v48 entry IS in English, so the trio drifted in language. Failure scenario: an EN-locale user expands the changelog (promised 'in English' by the PT summary too) and cannot read the v48 feature description.

**Evidence.**
```
index.html:1550-1553 comment: 'Changelog: collapsed by default. Entries are English-only by design (technical notes, not UI copy).'; index.html:1576-1578: '<p><strong>v48</strong> — 2026-06-29<br/> <strong>Comparação de rotas origem→destino.</strong> Com <em>"Comparar com cenário sem rede"</em> ligado, o seletor…'; CHANGELOG.md:70-88 v48 entry is English
```

**Fix approach.** Rewrite the v48 <p> block at index.html:1576-1586 in English, condensed from CHANGELOG.md's v48 entry (source→destination route comparison; scenario picker switches the best route too — terrain blue, network orange, both in difference view; hover/tap either route to compare both energies + Δ). Keep the PT UI-string quotes ('Comparar com cenário sem rede', 'Cenário exibido') as literal control names, matching the style of the other entries. This is a served-file change: bump sw.js VERSION and add a changelog line for the fix batch in all three changelog locations.

**Tests to run:** `Manual browser: open help → expand Changelog, verify v48 reads in English and control names still match the PT UI labels`

**Invariants — do not break:** Do not translate the changelog block into pt/en pairs (it is deliberately outside i18n); CHANGELOG.md's v48 entry is canonical — do not alter it; bump sw.js VERSION and keep the changelog trio moving together.

*(Fix approach independently re-verified as sound.)*

---

### [info] dem/vector/sampa-viario.gpkg (145 MB, OSM-derived) has no provenance documentation and no OSM/ODbL attribution; zero-byte stray twin at dem/ root

**Where:** `dem/vector/sampa-viario.gpkg:1`  
**Difficulty:** small  
**Fix touches:** `dem/vector/README.md`, `app.js`

**Problem.** The hosted 'Viário RMSampa' example network (fetched by the app from https://simujaules.pedalhidrografi.co/vector/sampa-viario.gpkg, app.js:1411; local copy dem/vector/sampa-viario.gpkg, 152,461,312 bytes, gitignored, uploaded out-of-band per deploy.sh:102) has no provenance documentation anywhere in the repo. Inspection shows it IS OpenStreetMap-derived: single layer `viario`, 443,872 LineStrings, EPSG:31983 (SIRGAS 2000 / UTM 23S), columns fid/geom/osm_id/name/highway/waterway/aerialway/barrier/man_made/railway/z_order/other_tags (the standard ogr2ogr 'lines' schema from an .osm.pbf extract), with QGIS 3.44.9 metadata embedded. OSM data is ODbL: serving it publicly requires '© OpenStreetMap contributors' attribution, which neither the example button (STRINGS key net.example_viario), the help modal, nor the README provides. Additionally a zero-byte stray dem/sampa-viario.gpkg (0 bytes, 2026-06-21) sits at the dem/ root.

**Evidence.**
```
sqlite3 dem/vector/sampa-viario.gpkg: gpkg_contents → 'viario|features|31983'; PRAGMA table_info(viario) → osm_id, name, highway, waterway, ..., other_tags; COUNT(*) = 443872; ls dem/ → '-rw-r--r-- ... 0 Jun 21 15:14 sampa-viario.gpkg'
```

**Fix approach.** (1) Create dem/vector/README.md documenting: what the file is (the hosted 'Viário RMSampa' example network, served from gs://simujaules/vector/ — uploaded out-of-band, never staged by deploy.sh, whose rsync excludes the vector/ prefix); contents (layer `viario`, 443,872 LineString features, EPSG:31983 SIRGAS 2000 / UTM 23S, ogr2ogr-style OSM lines schema with osm_id/highway/other_tags, processed in QGIS 3.44.9, file dated 2026-06-20); source and licence: data © OpenStreetMap contributors, ODbL 1.0 — leave the exact extract source/date as a TODO for the maintainer to fill (likely a Geofabrik sudeste extract; a fixer must not invent this). (2) Add OSM attribution where the example is offered: extend the STRINGS entry net.example_viario (or the adjacent hint text) in app.js with '(dados © OpenStreetMap, ODbL)' / '(data © OpenStreetMap, ODbL)' and mention it in the help modal's network section — this satisfies ODbL attribution for the served copy. (3) The zero-byte stray: per workspace policy permanent deletions are the user's call — do NOT delete it; include the command `rm dem/sampa-viario.gpkg` in the PR/commit description for the maintainer. Bump sw.js VERSION + changelog trio only if app.js/index.html text changed (it does, via the STRINGS edit).

**Tests to run:** `Browser: group 1B shows the attributed example label in PT and EN`, `git status — confirm dem/vector/README.md is tracked while the .gpkg files remain ignored (git check-ignore dem/vector/sampa-viario.gpkg)`

**Invariants — do not break:** Never `git add` the .gpkg (gitignored by design, .gitignore:231); deploy.sh's staged-file list and its vector/ rsync exclusion must not change; deletions (the zero-byte stray) are left to the user — provide the command only; STRINGS entries in both PT and EN; VERSION + changelog trio for the user-visible label change.

> ⚠️ **Adversarial re-check flagged the fix spec above as incomplete.** Amendment: Add an explicit step: after writing dem/vector/README.md, either (a) `git add -f dem/vector/README.md` (verify afterward with `git ls-files dem/vector/README.md` returning the path — not just `git check-ignore` on the .gpkg, which only proves the *data* file stays ignored and says nothing about the README), or (b) add a negation rule to .gitignore ordered after `dem/*`, e.g. `!dem/vector/README.md` (note: gitignore negation of a file inside an already-excluded directory only works if the directory itself isn't excluded from traversal — since `dem/*` matches `dem/vector` as a whole path segment, test this negation actually surfaces the file via `git status` before relying on it; `git add -f` is the more reliable option). Given this trap already silently ate the near-identical downloads/water_mask/README.md, the more robust fix is to put the provenance/licence note in a file that's already tracked — the top-level README.md (which already has a one-line mention of `dem/` at README.md:85 and is definitely committed) or docs/ — and treat dem/vector/README.md as an optional mirror for someone browsing the untracked local directory, not the sole copy. Minor/non-blocking preference: extend `net.example_viario_tag` (the size/hint subtitle already shown next to the button, index.html:903) rather than `net.example_viario` itself, since the latter also feeds the transient `status.fetching` message (app.js:2127) and lengthening it there reads awkwardly mid-fetch — the fix spec already allows this alternative ("or the adjacent hint text"), so just confirming it's the better choice, not requiring a change to the spec's wording.

---
## Phase 2 — LARGE item: linear aero taper across the climb threshold

**Do not run this alongside Phase 1's `LANE-WORKER`/`LANE-GRAPH`/`LANE-BACKEND`** —
same files, and this fix's correctness depends on the exact edge-cost formula
those lanes sit next to. Run alone, sequentially, after Phase 1 is committed.
This spec was independently re-derived and vetted by a second agent (see
*Verifier's math check* below) — it is close to implementation-ready as written.

### Aero on/off step at climbThr creates a per-edge cost cliff of aAero·dist that the optimizer exploits — fix with a linear aero taper across a grade band

**Where:** `energy-worker.js:92` (mirrored in backend/src/main.rs:254, graph-engine.js:104, app.js:7654, test-energy-v2.mjs:66)  
**Difficulty:** large  
**Fix touches:** `energy-worker.js`, `backend/src/main.rs`, `graph-engine.js`, `app.js`, `test-energy-v2.mjs`, `backend/test-backend.mjs`, `test-graph-engine.mjs`, `census/census-density.mjs`, `README.md`, `llms.txt`

**Problem.** v2Edge (energy-worker.js:90-102), the single per-edge cost function every engine routes through, drops the entire aero term discontinuously at the climb threshold: an uphill edge at grade climbThr-epsilon costs aAero·dist MORE than the same edge at grade climbThr. Dijkstra/A*/density therefore systematically prefer edges whose grade sits just AT/above the threshold (they shed the whole aero term while gaining height at only beta·dh), so optimal routes snap to an artificial 2%-grade contour that is a model artifact, not physics. The physical rationale for the step ('on climbs you ride slower so aero ≈ 0') implies a gradual speed transition, so a linear blend is strictly more faithful. This function is mirrored byte-identically in FOUR places (backend/src/main.rs v2_edge:254, graph-engine.js stepCost:104, app.js refEnergyKJ:7654 closed-form, test-energy-v2.mjs:66), all of which must move together — this fix is LARGE.

**Evidence.**
```js
function v2Edge(dist, dh, c) {
  if (dh >= 0) {
    const aero = (dh < c.climbThr * dist) ? c.aAero * dist : 0;
    return c.aRoll * dist + aero + c.beta * dh;
  }
```

**Fix approach.** Add a cost-bundle field climbTaper (grade half-width Δ, default 0.005 = 0.5%; Δ=0 must reproduce the current step bit-for-bit). For dh >= 0 with s = dh/dist: w = 1 if s <= climbThr-Δ; w = (climbThr+Δ-s)/(2*Δ) if inside the band; w = 0 if s >= climbThr+Δ; cost = aRoll*dist + w*aAero*dist + beta*dh. Guard with `if (!(c.climbTaper > 0)) { ...existing branch... }` so legacy bundles are bit-identical. Implement in ALL mirrors with IDENTICAL operation order: (1) energy-worker.js v2Edge (line 90); (2) backend/src/main.rs v2_edge (line 254) + add `#[serde(default)] climb_taper: f64` to the Cost struct (line ~82) so old clients/tests deserialize as 0; (3) graph-engine.js stepCost (line 104) — must stay line-identical to v2Edge (the v49 cross-module stepCost≡v2Edge test in test-graph-engine.mjs enforces this); (4) app.js refEnergyKJ (line 7654): replace `if (dh < c.climbThr * d) Xnc += d` with the weighted `Xnc += w*d` using the same w formula; (5) test-energy-v2.mjs deriveCost + its refEnergyKJ mirror (line 66). Plumbing: app.js readCost (~line 726-747) adds climbTaper to the bundle (either a fixed `const CLIMB_TAPER = 0.005` or, preferably, an advanced numeric input '#climb-taper' in index.html with a STRINGS/data-i18n label, included in the config save/restore id lists around app.js:766-773); bundle export (app.js:9184 region, next to climbThr) writes climbTaper and the import path (app.js:9678 region) defaults MISSING climbTaper to 0 so old bundles replay with legacy semantics; also grep census/census-density.mjs for climbThr and add climbTaper:0 to its bundle. A* heuristic: NO change needed — leave climbFloor (energy-worker.js:636) as is and add a comment with this proof: the taper per-metre uphill cost aRoll + w(s)*aAero + beta*s is linear in s inside the band, so its minimum over s>=0 is aRoll + min(aAero at s=0, beta*(climbThr+Δ) at the upper band edge), which is >= the existing floor aRoll + min(aAero, beta*climbThr); maxEdgeCost (line 1377) already uses full aAero (w<=1), still an upper bound. Add parity cases with climb_taper=0.005 (grades straddling the band) to backend/test-backend.mjs, taper unit cases (band-edge continuity, midpoint w=0.5, Δ=0 ≡ old) to test-energy-v2.mjs. Update the cost-model docs: v2Edge header comment (energy-worker.js:8-18), help-modal theory section, README 'What it computes', llms.txt. Ship as its own version: bump sw.js VERSION + move the changelog trio (CHANGELOG.md, index.html <details id="changelog">, sw.js comment).

**Tests to run:** `node test-energy-v2.mjs`, `node test-worker-pool.mjs`, `node test-graph-engine.mjs`, `cd backend && cargo build --release && node test-backend.mjs`, `node test-water-raster.mjs`, `browser smoke: load a DEM, run from/to and density with taper 0 and 0.005`

**Invariants — do not break:** JS<->Rust bit-parity (identical floating-point operation order in v2Edge/v2_edge; test-backend.mjs must stay bit-identical); graph-engine stepCost must remain line-identical to v2Edge (cross-module test); test-energy-v2.mjs mirrors are hand-kept-in-sync with app.js; climbTaper=0 (and every old bundle, which lacks the field) must reproduce current results bit-for-bit; any new UI text goes through STRINGS/data-i18n (PT+EN), never hardcoded; sw.js VERSION bump + changelog trio move together; style knobs must still never trigger recompute.

**Verifier's math check** (independent re-derivation, not just a read-through): Verified directly against the checked-out tree (clean). All four evidence quotes line up exactly: energy-worker.js:90-102 v2Edge (line 92: `const aero = (dh < c.climbThr * dist) ? c.aAero * dist : 0;`), backend/src/main.rs v2_edge at line 254 (`let aero = if dh < c.climb_thr * dist { c.a_aero * dist } else { 0.0 };`), graph-engine.js stepCost at line 104-106, and app.js refEnergyKJ at line 7654 (`if (dh >= 0) { hPlus += dh; if (dh < c.climbThr * d) Xnc += d; }`), plus test-energy-v2.mjs's mirror at line 66. The discontinuity is real: at grade s just below climbThr the edge pays aRoll*d + aAero*d + beta*dh, at s == climbThr it drops to aRoll*d + beta*dh — a cliff of exactly aAero*d with no interpolation. Because dh/dist for a given pair of grid cells is fixed by real terrain but Dijkstra/A*/density choose AMONG competing paths/decompositions of the same net rise (different cell sequences, diagonal vs cardinal steps, DEM micro-noise), a discontinuous per-edge cost is a genuine non-physical bias toward edges that happen to sit at/above the threshold — this matches the code comment's own framing ("aero off climbs" as a step simplification) and is why the prior full review flagged it and deliberately deferred it as a dedicated-dimension item, which this finding correctly targets. I could not construct a scenario that refutes the discontinuity's existence or its mirrored presence in all four cited files — every line/quote checks out verbatim.

Fix-spec vetting: the taper algebra is correct. Continuity checks out (w=1 at s=climbThr-Δ, w=0.5 at s=climbThr, w=0 at s=climbThr+Δ). The A*-heuristic argument is verified by hand: the new per-metre climb floor after tapering is aRoll + min(aAero, beta*(climbThr+Δ)), which is >= the existing climbFloor at energy-worker.js:636 (aRoll + min(aAero, beta*climbThr)) since min(a,x) is non-decreasing in x and climbThr+Δ > climbThr — so leaving climbFloor unchanged keeps the A* heuristic admissible/consistent (just slightly less tight), and maxEdgeCost (line 1377, uses full aAero unconditionally) remains a valid upper bound since w<=1. The climbTaper=0 legacy-guard bit-identity claim is sound as specified (`if (!(c.climbTaper > 0)) { ...old branch... }` short-circuits to the byte-identical old code). Plumbing claims all check out: readCost() (app.js:717-742), PERSIST_IDS (app.js:757-778), bundle export (app.js:9184) and import (app.js:9678) all currently touch climbThr exactly where claimed and generalize cleanly to climbTaper; cost flows to the backend as a JSON blob (app.js:6017-6030) so no extra backend wire-plumbing is needed beyond the Cost struct; the Rust Cost struct (main.rs:76-85, rename_all=camelCase) accepts `#[serde(default)] climb_taper: f64` exactly as described; census/census-density.mjs (confirmed) drives the REAL energy-worker.js rather than re-implementing v2Edge, so it only needs a climbTaper:0 default in its own deriveCost mirror, not a fifth v2Edge port — the finding's phrasing correctly distinguishes this. README.md and llms.txt both do contain the "aero dropped at/above the climb threshold" prose exactly as cited, confirming those need updating too. The graph-engine cross-module parity test at test-graph-engine.mjs:336-373 does exist as described (extracts the live v2Edge via `new Function` and asserts bit-for-bit equality against stepCost across sampled bundles/grades) and would indeed catch a divergence.

---

## After Phase 1 and Phase 2 both land

1. Run the full test sweep listed in Phase 3 above.
2. Bump `sw.js` `VERSION` once per phase (so v51 = Phase 1 batch, v52 = Phase 2
   aero taper, or combine into one release — maintainer's call), with the
   changelog trio (`CHANGELOG.md`, the help-modal `<details id="changelog">` in
   `index.html`, the `sw.js` version-history comment) all moving together.
3. Run an adversarial review of the combined diff before committing — spawn one
   verifier per lane's diff, instructed to try to refute each change against the
   invariants stated above, the same way the v49 release was double-checked.
4. Author the release commit(s) per the repo convention: 
   `git commit --author="Claude <noreply@anthropic.com>"` with a
   `Co-Authored-By: Danilo Lessa Bernardineli <danilo.lessa@gmail.com>` trailer.