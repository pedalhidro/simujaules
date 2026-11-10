// Pre-split preparation of the monolithic app.js (explicit, reviewable edits).
//
//   node prep.mjs <app.js in> <app.js out>
//
// Stage A — setters: ES imports are read-only, so the four `let` bindings that
//   are assigned from another section get a setter next to their declaration,
//   and the foreign assignments call it. Exact-once string replacements.
// Stage B — relocations: move a few blocks so the contiguous slices line up
//   with the concerns. Checked on the AST: the multiset of top-level
//   statements is unchanged, and the ORDER of every non-function statement
//   (the only order that can matter — function declarations are hoisted) is
//   unchanged.
import { readFileSync, writeFileSync } from "fs";
import * as acorn from "acorn";

const [inPath, outPath] = process.argv.slice(2);
let src = readFileSync(inPath, "utf8");

function once(find, repl) {
  const n = src.split(find).length - 1;
  if (n !== 1) throw new Error(`expected exactly 1 match, got ${n}: ${JSON.stringify(find.slice(0, 90))}`);
  src = src.replace(find, () => repl);
}

// ---- Stage A: setters --------------------------------------------------------
once("let refreshLayerOrderList = null;\n",
     "let refreshLayerOrderList = null;\nfunction setRefreshLayerOrderList(fn) { refreshLayerOrderList = fn; }\n");
once("let refreshColormapLabels = null;\n",
     "let refreshColormapLabels = null;\nfunction setRefreshColormapLabels(fn) { refreshColormapLabels = fn; }\n");
once("  refreshLayerOrderList = renderOrderList;\n", "  setRefreshLayerOrderList(renderOrderList);\n");
once(`  refreshColormapLabels = () => {
    if (sel) rebuildColormapOptions(sel);
    if (routesSel) rebuildColormapOptions(routesSel);
    if (maxsegSel) rebuildColormapOptions(maxsegSel);
  };
`, `  setRefreshColormapLabels(() => {
    if (sel) rebuildColormapOptions(sel);
    if (routesSel) rebuildColormapOptions(routesSel);
    if (maxsegSel) rebuildColormapOptions(maxsegSel);
  });
`);

once("let layerOrder = DEFAULT_LAYER_ORDER.slice();\n",
     "let layerOrder = DEFAULT_LAYER_ORDER.slice();\nfunction setLayerOrder(order) { layerOrder = order; }\n");
once("    layerOrder = valid.concat(DEFAULT_LAYER_ORDER.filter((k) => !valid.includes(k)));\n",
     "    setLayerOrder(valid.concat(DEFAULT_LAYER_ORDER.filter((k) => !valid.includes(k))));\n");
once("    layerOrder = DEFAULT_LAYER_ORDER.slice();\n    applyLayerOrder();\n    renderOrderList();\n",
     "    setLayerOrder(DEFAULT_LAYER_ORDER.slice());\n    applyLayerOrder();\n    renderOrderList();\n");

once(`let activeColormap = "cmo_phase"; // cmocean.phase — cyclic, perceptually uniform\n`,
     `let activeColormap = "cmo_phase"; // cmocean.phase — cyclic, perceptually uniform\nfunction setActiveColormap(name) { activeColormap = name; }\n`);
once(`        if (id === "colormap" && COLORMAPS[saved[id]]) activeColormap = saved[id];\n`,
     `        if (id === "colormap" && COLORMAPS[saved[id]]) setActiveColormap(saved[id]);\n`);
once(`      if (id === "colormap" && COLORMAPS[params[id]]) activeColormap = params[id];\n`,
     `      if (id === "colormap" && COLORMAPS[params[id]]) setActiveColormap(params[id]);\n`);
once("      activeColormap = sel.value;\n      applyColormapToLegend();\n      markStyleDirty();\n",
     "      setActiveColormap(sel.value);\n      applyColormapToLegend();\n      markStyleDirty();\n");
once("    activeColormap = v.fieldColormap;\n", "    setActiveColormap(v.fieldColormap);\n");

const afterA = src;

// ---- Stage B: relocations ------------------------------------------------------
// Move lines [first line starting with `from` … line before the first line
// starting with `until`) to just before the line starting with `before`.
function moveBlock(from, until, before) {
  const L = src.split("\n");
  const idx = (p) => { const h = []; L.forEach((l, i) => { if (l.startsWith(p)) h.push(i); }); if (h.length !== 1) throw new Error(`anchor matches ${h.length} lines: ${JSON.stringify(p)}`); return h[0]; };
  const a = idx(from), b = idx(until), c = idx(before);
  if (!(a < b) || (c > a && c < b)) throw new Error("bad move range");
  const block = L.slice(a, b);
  const rest = [...L.slice(0, a), ...L.slice(b)];
  const c2 = c < a ? c : c - block.length;
  src = [...rest.slice(0, c2), ...block, ...rest.slice(c2)].join("\n");
}

// R1: the legend-tick / range-input helpers sit at the tail of the GPX
//     section; they belong with the rendering code.
moveBlock("function updateLegendTicks() {", "// Shared conservative memory budget (bytes) for browser worker pools",
          "// ------- Reference geometry (GPX overlay) -------");
// R2: the shared DOM handles get their own banner (they are used everywhere,
//     not only by the DEM loader).
once("// ------- DEM loading -------\nconst demFile = document.getElementById(\"dem-file\");",
     "// ------- Shared DOM handles -------\nconst demFile = document.getElementById(\"dem-file\");");
once("\n// Construct the rmsampa-v2 XYZ tile layer once.", "\n// ------- DEM loading -------\n// Construct the rmsampa-v2 XYZ tile layer once.");
// R3: the bundle section's intro comment sits above the GeoTIFF helpers, ~500
//     lines before the bundle code; move it down to where that code starts.
moveBlock("// ------- Bundle download / reload -------", "// ---- GeoTIFF helpers",
          "// Vocab IRI deliberately points at the actual deployed file rather than an");

// ---- checks --------------------------------------------------------------------
const parse = (s) => { const comments = []; const ast = acorn.parse(s, { ecmaVersion: "latest", sourceType: "module", ranges: true, onComment: comments }); return { ast, comments, s }; };
const A = parse(afterA), B = parse(src);
const texts = (P) => P.ast.body.map((n) => P.s.slice(n.start, n.end));
const sorted = (x) => [...x].sort();
const eq = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
if (!eq(sorted(texts(A)), sorted(texts(B)))) throw new Error("relocation changed the set of top-level statements");
const nonFn = (P) => P.ast.body.filter((n) => n.type !== "FunctionDeclaration").map((n) => P.s.slice(n.start, n.end));
if (!eq(nonFn(A), nonFn(B))) throw new Error("relocation reordered a non-function top-level statement");
const ca = sorted(A.comments.map((c) => c.value)), cb = sorted(B.comments.map((c) => c.value));
const added = cb.filter((c) => !ca.includes(c)), lost = ca.filter((c) => !cb.includes(c));
if (lost.length) throw new Error("relocation lost a comment: " + JSON.stringify(lost[0]));
writeFileSync(outPath, src);
console.log(`prep ok: ${A.ast.body.length} top-level statements; non-function order unchanged; comments added: ${JSON.stringify(added)}`);
