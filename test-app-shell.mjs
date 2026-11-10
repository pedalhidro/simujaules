// App-shell consistency. Run with `node test-app-shell.mjs` (no dependencies).
//
// The app is build-free, so three hand-written lists have to agree with what
// the code actually loads: the `import`s / worker URLs in the sources, sw.js's
// PRECACHE_URLS, and the files deploy.sh stages. Nothing else checks them, and
// the failure modes are total: `cache.addAll` is atomic, so ONE precache URL
// that 404s blocks the service-worker install for every user; a module that is
// imported but not shipped (or shipped under a different `?v=` stamp than its
// importers use) breaks the page on load.
//
// This derives the truth from the sources and checks the lists against it:
//   1. every PRECACHE_URLS entry, and every same-origin asset index.html
//      references, exists on disk;
//   2. the ES-module graph reachable from index.html, the workers, and what the
//      workers importScripts are all precached — and no precached script is
//      orphaned;
//   3. every named import resolves to an export of its target module;
//   3b. the evaluation-order chain of app/ holds (see app.js): the entry
//      imports the last module first and lists every module, each module's
//      first import is its predecessor, and nothing assigns to an import;
//   4. deploy.sh's real staging + version stamping (its DEPLOY_STAGE_ONLY
//      hook; needs bash): every staged precache URL resolves to a staged file,
//      every import carries the sw.js VERSION stamp and resolves, the URLs the
//      page requests are exactly the URLs precached, and no dev file is staged.
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, posix, relative } from "path";
import { tmpdir } from "os";

const root = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error("  FAIL:", msg); } };

// ---- source scanners (regex on purpose: no parser dependency) -----------------
// Static imports in this codebase start at column 0 and use double quotes;
// the lazy group spans a multi-line `import {\n  a, b,\n} from "…";` but can
// never cross a quote, so a bare `import "./x.js";` is not swallowed into the
// import statement that follows it.
const IMPORT_RE = /^(?:import|export)\s+(?:([^"]*?)\s+from\s+)?"([^"]+)";?/gm;
function parseImports(src) {
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    if (m[0].startsWith("export") && m[1] === undefined) continue; // `export "x"` is not a thing
    const names = [];
    const braces = m[1] && /\{([\s\S]*)\}/.exec(m[1]);
    if (braces) for (const part of braces[1].split(",")) {
      const p = part.trim();
      if (p) names.push(p.split(/\s+as\s+/)[0].trim());
    }
    out.push({ spec: m[2], names });
  }
  return out;
}
// Exports: `export function f`, `export async function f`, `export const|let|class X`,
// `export { a, b as c }`. A multi-declarator `export const A = 1, B = 2;` only
// yields A — split such a declaration if B must be imported elsewhere.
function parseExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*;?\s*$/gm))
    for (const part of m[1].split(",")) { const p = part.trim(); if (p) names.add(p.split(/\s+as\s+/).pop().trim()); }
  return names;
}
const stripQuery = (u) => u.split("?")[0];
const queryOf = (u) => (u.includes("?") ? u.slice(u.indexOf("?")) : "");

// Walk the module graph from an entry (paths relative to `base`, posix, no
// leading "./"). Returns Map(path -> { src, imports: [{spec, names, target}] }).
function moduleGraph(base, entry) {
  const graph = new Map();
  const todo = [entry];
  while (todo.length) {
    const p = todo.pop();
    if (graph.has(p)) continue;
    const file = join(base, p);
    if (!existsSync(file)) { graph.set(p, { missing: true, imports: [] }); continue; }
    const src = readFileSync(file, "utf8");
    const imports = parseImports(src).map((im) => {
      const target = posix.normalize(posix.join(posix.dirname(p), stripQuery(im.spec)));
      return { ...im, target };
    });
    graph.set(p, { src, imports });
    for (const im of imports) todo.push(im.target);
  }
  return graph;
}

// Worker scripts the page spawns, and the wasm modules it fetches: read from
// the URL constants, whichever module holds them.
function workerUrls(graph) {
  const workers = [], wasm = [];
  for (const { src } of graph.values()) {
    if (!src) continue;
    for (const m of src.matchAll(/^(?:export )?const \w*WORKER_URL = "([^"]+)";/gm)) workers.push(m[1]);
    for (const m of src.matchAll(/^(?:export )?const WASM_ENGINE_URLS = \{([^}]*)\};/gm))
      for (const s of m[1].matchAll(/"([^"]+)"/g)) wasm.push(s[1]);
  }
  return { workers, wasm };
}
function importScriptsOf(base, p, seen = new Map()) {
  if (seen.has(p)) return seen;
  const file = join(base, p);
  if (!existsSync(file)) { seen.set(p, null); return seen; }
  const src = readFileSync(file, "utf8");
  // Call sites only (`importScripts("x.js")`), wherever they sit on the line —
  // energy-worker.js wraps its one in a try { … } catch.
  // Comment lines are skipped (graph-engine.js's header mentions how it is loaded).
  const specs = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .flatMap((l) => [...l.matchAll(/\bimportScripts\("([^"]+)"\)/g)].map((m) => m[1]));
  seen.set(p, specs);
  for (const s of specs) importScriptsOf(base, posix.normalize(posix.join(posix.dirname(p), stripQuery(s))), seen);
  return seen;
}
function readSw(base) {
  const src = readFileSync(join(base, "sw.js"), "utf8");
  const version = /^const VERSION\s*=\s*"(v\d+)";/m.exec(src)?.[1];
  const block = /^const PRECACHE_URLS = \[([\s\S]*?)^\];/m.exec(src)?.[1] ?? "";
  const urls = [...block.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((m) => m[1]);
  return { version, urls };
}
function entryOf(base) {
  const html = readFileSync(join(base, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  return { html, scripts };
}
const rel = (u) => posix.normalize(u); // "./x/y.js" -> "x/y.js"

// ============================================================================
console.log("sources");
const sw = readSw(root);
ok(/^v\d+$/.test(sw.version || ""), `sw.js VERSION parses (${sw.version})`);
ok(sw.urls.length >= 10, `PRECACHE_URLS parses (${sw.urls.length} entries)`);
ok(new Set(sw.urls).size === sw.urls.length, "PRECACHE_URLS has no duplicates");
ok(sw.urls.every((u) => u.startsWith("./") && !u.includes("?")), "PRECACHE_URLS entries are relative and unstamped in the repo");
for (const u of sw.urls) ok(existsSync(join(root, rel(u))), `precached file exists: ${u}`);

const { html, scripts } = entryOf(root);
ok(scripts.length === 1 && scripts[0] === "./app.js", `index.html loads exactly one module script, ./app.js (${scripts.join(", ")})`);
// Same-origin assets index.html points at (manifest, icons, favicon…).
const assets = new Set([...html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)].map((m) => m[1]));
for (const a of assets) ok(existsSync(join(root, rel(a))), `index.html asset exists: ${a}`);

console.log("module graph");
const graph = moduleGraph(root, "app.js");
for (const [p, node] of graph) {
  ok(!node.missing, `imported module exists: ${p}`);
  for (const im of node.imports) {
    ok(/^\.\.?\//.test(im.spec) && im.spec.endsWith(".js") && !im.spec.includes("?"), `${p}: import specifier is relative, .js, unstamped in the repo ("${im.spec}")`);
    const tgt = graph.get(im.target);
    if (!tgt || tgt.missing) continue;
    const exported = parseExports(tgt.src);
    for (const n of im.names) ok(exported.has(n), `${p}: "${im.spec}" exports ${n}`);
  }
}
const { workers, wasm } = workerUrls(graph);
ok(workers.length === 2, `found the two worker URL constants (${workers.join(", ")})`);
ok(wasm.length === 2, `found the two wasm engine URLs (${wasm.join(", ")})`);
const workerFiles = new Map();
for (const w of workers) importScriptsOf(root, rel(w), workerFiles);
for (const [p, specs] of workerFiles) ok(specs !== null, `worker script exists: ${p}`);
for (const w of wasm) ok(existsSync(join(root, rel(w))), `wasm engine exists: ${w}`);

// ---- the app/ evaluation-order chain ------------------------------------------
// app/ modules import each other in cycles (fine for hoisted functions), so
// the ORDER in which their top-level code runs is pinned by a chain instead:
// app.js imports the LAST module first, and every module's first import is
// its predecessor. Break the chain and top-level code (the map, `state`, the
// DOM handles, every addEventListener) runs in a different order.
console.log("app/ evaluation-order chain");
{
  const entry = graph.get("app.js");
  const listed = entry.imports.map((im) => im.target);
  ok(entry.imports.every((im) => im.names.length === 0 && /^app\/[\w-]+\.js$/.test(im.target)), "app.js contains only side-effect imports of app/*.js");
  ok(new Set(listed).size === listed.length, "app.js lists each module once");
  const onDisk = readdirSync(join(root, "app")).filter((f) => f.endsWith(".js")).map((f) => `app/${f}`).sort();
  ok(onDisk.length === listed.length && onDisk.every((f) => listed.includes(f)), `app.js lists exactly the files in app/ (${listed.length} listed, ${onDisk.length} on disk)`);
  const order = [...listed.slice(1), listed[0]]; // evaluation order: the first import is the LAST module
  order.forEach((p, i) => {
    const node = graph.get(p);
    if (!node || node.missing) return;
    const sideEffect = node.imports.filter((im) => im.names.length === 0);
    if (i === 0) ok(sideEffect.length === 0, `${p} (first in the chain) has no side-effect import`);
    else {
      ok(node.imports[0]?.target === order[i - 1] && node.imports[0].names.length === 0, `${p}: first import is its predecessor ${order[i - 1]}`);
      ok(sideEffect.length === 1, `${p}: exactly one side-effect import`);
    }
    // ES imports are read-only bindings: assigning to one throws — at RUN
    // time, only when that line executes, so it would slip past a page-load
    // check. Cross-module state goes through a setter in the declaring module
    // (setActiveColormap, setLayerOrder…). Heuristic, not a parser: a name
    // that the module also declares locally somewhere (a shadowing const/let,
    // parameter or arrow argument) is skipped, and // comments are ignored.
    const code = node.src.replace(/(^|\s)\/\/.*$/gm, "$1");
    for (const n of node.imports.flatMap((im) => im.names)) {
      const N = n.replace(/\$/g, "\\$");
      const shadowed = new RegExp(`\\b(?:const|let|var)\\s+(?:[\\[{][^=;]*)?\\b${N}\\b|\\bfunction\\b[^(]*\\([^)]*\\b${N}\\b|\\(\\s*[^()]*\\b${N}\\b[^()]*\\)\\s*=>|\\b${N}\\s*=>|\\bfor\\s*\\(\\s*(?:const|let|var)\\s[^)]*\\b${N}\\b`).test(node.src);
      if (shadowed) continue;
      const assigns = new RegExp(`(^|[^.\\w$"'\`])${N}\\s*(=(?![=>])|[-+*/%&|^]=|\\+\\+|--)`, "m");
      ok(!assigns.test(code), `${p}: never assigns to its import ${n}`);
    }
  });
}

console.log("precache ⊇ what the page loads");
const precached = new Set(sw.urls.map(rel));
// engine64.wasm is deliberately NOT precached: only DEMs past 4 GiB need it,
// and the fetch handler runtime-caches it on first use.
const RUNTIME_ONLY = new Set(["engine64.wasm"]);
const shell = new Set(["index.html", ...graph.keys(), ...workerFiles.keys(), ...wasm.map(rel).filter((w) => !RUNTIME_ONLY.has(w))]);
for (const p of shell) ok(precached.has(p), `precached: ${p}`);
for (const p of precached) if (/\.(js|wasm)$/.test(p)) ok(shell.has(p), `precached script is actually loaded by the page: ${p}`);
for (const p of RUNTIME_ONLY) ok(!precached.has(p), `${p} stays runtime-cached (not in PRECACHE_URLS)`);

// ============================================================================
console.log("deploy.sh staging (DEPLOY_STAGE_ONLY)");
const stage = mkdtempSync(join(tmpdir(), "simu-stage-"));
try {
  const r = spawnSync("bash", ["deploy.sh"], { cwd: root, env: { ...process.env, DEPLOY_STAGE_ONLY: stage }, encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT") {
    console.log("  (bash not available — skipping the staging checks)");
  } else {
    ok(r.status === 0, `deploy.sh stage-only exits 0${r.status === 0 ? "" : ":\n" + (r.stdout + r.stderr).split("\n").slice(-12).join("\n")}`);
    if (r.status === 0) {
      const V = sw.version, Q = `?v=${V}`;
      const staged = [];
      (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else staged.push(relative(stage, p).split("\\").join("/")); } })(stage);
      const stagedSet = new Set(staged);

      const ssw = readSw(stage);
      ok(ssw.version === V, "staged sw.js keeps VERSION");
      ok(ssw.urls.length === sw.urls.length, "staged PRECACHE_URLS has the same number of entries");
      for (const u of ssw.urls) {
        ok(stagedSet.has(rel(stripQuery(u))), `staged precache URL resolves to a staged file: ${u}`);
        ok(queryOf(u) === (/\.(js|wasm)$/.test(stripQuery(u)) ? Q : ""), `staged precache URL stamp: ${u}`);
      }
      const sprecached = new Set(ssw.urls.map(rel));

      const sEntry = entryOf(stage).scripts;
      ok(sEntry.length === 1 && sEntry[0] === `./app.js${Q}`, `staged index.html loads ./app.js${Q} (${sEntry.join(", ")})`);

      const sgraph = moduleGraph(stage, "app.js");
      ok(sgraph.size === graph.size && [...graph.keys()].every((p) => sgraph.has(p)), `staged module graph is the repo's (${sgraph.size} vs ${graph.size} modules)`);
      for (const [p, node] of sgraph) {
        ok(!node.missing, `staged module exists: ${p}`);
        // The URL the browser requests for this module = its path + the stamp;
        // it must be a precache key verbatim, or the SW misses it offline.
        ok(sprecached.has(p + Q), `requested URL is precached verbatim: ./${p}${Q}`);
        for (const im of node.imports) ok(queryOf(im.spec) === Q, `${p}: staged import is stamped ("${im.spec}")`);
      }
      const sw2 = workerUrls(sgraph);
      for (const w of [...sw2.workers, ...sw2.wasm]) {
        ok(queryOf(w) === Q, `staged worker/engine URL is stamped: ${w}`);
        ok(stagedSet.has(rel(stripQuery(w))), `staged worker/engine file exists: ${w}`);
        if (!RUNTIME_ONLY.has(rel(stripQuery(w)))) ok(sprecached.has(rel(w)), `worker/engine URL is precached verbatim: ${w}`);
      }
      const sworkers = new Map();
      for (const w of sw2.workers) importScriptsOf(stage, rel(stripQuery(w)), sworkers);
      for (const [p, specs] of sworkers) {
        ok(specs !== null, `staged worker script exists: ${p}`);
        for (const s of specs || []) {
          ok(queryOf(s) === Q, `${p}: staged importScripts is stamped ("${s}")`);
          ok(sprecached.has(rel(posix.join(posix.dirname(p), s))), `importScripts URL is precached verbatim: ${s}`);
        }
      }

      // Only the app ships: no tests, tooling, manifests or docs beyond the
      // few that are deliberately public.
      const DEV = /(^|\/)(test-[^/]*\.mjs|package(-lock)?\.json|README\.md|CLAUDE\.md|[^/]*\.sh|[^/]*\.rs|Cargo\.[a-z]+|\.env[^/]*|\.gitignore)$/;
      for (const f of staged) ok(!DEV.test(f), `no dev file staged: ${f}`);
      for (const f of staged) if (/^(app|lib)\/.*\.js$/.test(f) || f === "app.js") ok(sgraph.has(f), `staged module is reachable from app.js: ${f}`);
    }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nALL PASS — ${passed} checks`);
process.exit(failed ? 1 : 0);
