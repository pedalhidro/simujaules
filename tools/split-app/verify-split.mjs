// Independent check of a split produced by split.mjs.
//
//   node verify-split.mjs <prepared-app.js> <outDir>
//
// Parses the original and every generated module from scratch and asserts:
//   1. the top-level statements of the modules, concatenated in entry order,
//      are the original's top-level statements — same count, same order, same
//      source text (an `export ` prefix is the only permitted difference);
//   2. every comment of the original survives exactly once (generated header
//      comments excluded);
//   3. the chain: module k's first import is module k-1, the entry's first
//      import is the last module, and the entry lists every module;
//   4. every named import resolves to an export of the target module, no
//      module imports a name it does not use, and none assigns to an import;
//   5. nothing references a top-level binding of another module without
//      importing it (free identifiers ⊆ own declarations ∪ imports ∪ the
//      original file's own free identifiers, i.e. browser/CDN globals).
import { readFileSync, readdirSync } from "fs";
import { join, posix } from "path";
import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";

const [origPath, outDir, planPath] = process.argv.slice(2);
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error("FAIL:", msg); } };
const parse = (src) => {
  const comments = [];
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", ranges: true, locations: true, onComment: comments });
  return { ast, comments, scope: eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module" }) };
};

const orig = readFileSync(origPath, "utf8");
const O = parse(orig);
const origStmts = O.ast.body.filter((n) => n.type !== "ImportDeclaration").map((n) => orig.slice(n.start, n.end));
const origGlobals = new Set(O.scope.globalScope.through.map((r) => r.identifier.name));
const origImports = new Map(); // local name -> source basename
for (const n of O.ast.body) if (n.type === "ImportDeclaration") for (const s of n.specifiers) origImports.set(s.local.name, posix.basename(n.source.value));

// ---- entry ---------------------------------------------------------------
const entrySrc = readFileSync(join(outDir, "app.js"), "utf8");
const E = parse(entrySrc);
ok(E.ast.body.every((n) => n.type === "ImportDeclaration" && n.specifiers.length === 0), "entry contains only side-effect imports");
const entryMods = E.ast.body.map((n) => n.source.value);
const files = readdirSync(join(outDir, "app")).filter((f) => f.endsWith(".js")).sort();
ok(new Set(entryMods).size === entryMods.length, "entry imports each module once");
ok(entryMods.length === files.length && files.every((f) => entryMods.includes(`./app/${f}`)), "entry lists exactly the files in app/");
const order = [...entryMods.slice(1), entryMods[0]].map((s) => s.replace("./app/", "")); // evaluation order

// ---- modules ---------------------------------------------------------------
const mods = order.map((f) => {
  const src = readFileSync(join(outDir, "app", f), "utf8");
  const P = parse(src);
  const exports = new Set(), imports = [], stmtsOut = [];
  for (const n of P.ast.body) {
    if (n.type === "ImportDeclaration") { imports.push(n); continue; }
    if (n.type === "ExportNamedDeclaration") {
      ok(n.declaration && !n.source && n.specifiers.length === 0, `${f}: only 'export <declaration>' is generated`);
      const d = n.declaration;
      ok(src.slice(n.start, d.start) === "export ", `${f}: export prefix is exactly 'export '`);
      if (d.type === "VariableDeclaration") for (const dd of d.declarations) for (const id of patternNames(dd.id)) exports.add(id);
      else exports.add(d.id.name);
      stmtsOut.push(src.slice(d.start, d.end));
    } else {
      ok(!n.type.startsWith("Export"), `${f}: unexpected ${n.type}`);
      stmtsOut.push(src.slice(n.start, n.end));
    }
  }
  return { f, src, P, exports, imports, stmtsOut };
});
function patternNames(p) {
  if (p.type === "Identifier") return [p.name];
  if (p.type === "ObjectPattern") return p.properties.flatMap((q) => patternNames(q.value || q.argument));
  if (p.type === "ArrayPattern") return p.elements.filter(Boolean).flatMap(patternNames);
  if (p.type === "AssignmentPattern") return patternNames(p.left);
  if (p.type === "RestElement") return patternNames(p.argument);
  throw new Error("pattern " + p.type);
}

// 1. statements
const got = mods.flatMap((m) => m.stmtsOut);
ok(got.length === origStmts.length, `statement count ${got.length} vs original ${origStmts.length}`);
let firstDiff = -1;
for (let i = 0; i < Math.min(got.length, origStmts.length); i++) if (got[i] !== origStmts[i]) { firstDiff = i; break; }
ok(firstDiff === -1, `statement ${firstDiff} differs: ${JSON.stringify((got[firstDiff] || "").slice(0, 80))} vs ${JSON.stringify((origStmts[firstDiff] || "").slice(0, 80))}`);

// 2. comments (module files only; the generated header comment block of each
//    module ends at its first import/statement, so drop comments before the
//    first non-import statement that also precede the last import).
const origComments = O.comments.map((c) => c.value);
const gotComments = [];
for (const m of mods) {
  const lastImportEnd = m.imports.length ? Math.max(...m.imports.map((n) => n.end)) : 0;
  // …to the end of the last import's LINE (the chain import carries a trailing comment).
  const headEnd = m.imports.length ? m.src.indexOf("\n", lastImportEnd) : firstBlankAfterHeader(m.src);
  for (const c of m.P.comments) if (c.start >= headEnd) gotComments.push(c.value);
}
function firstBlankAfterHeader(src) { const k = src.indexOf("\n\n"); return k < 0 ? 0 : k; }
// The original's file-header comment (everything above the first module's
// first line) is replaced by the entry's own header.
const firstAnchor = JSON.parse(readFileSync(planPath, "utf8")).firstModuleStartsAt;
const headerEnd = orig.split("\n").findIndex((l) => l.startsWith(firstAnchor));
const headerEndOff = orig.split("\n").slice(0, headerEnd).join("\n").length;
const need = origComments.filter((c, i) => O.comments[i].start >= headerEndOff);
console.log(`(original header comments replaced by the entry: ${origComments.length - need.length})`);
const count = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
const cn = count(need), cg = count(gotComments);
let missing = 0, extra = 0;
for (const [k, n] of cn) if ((cg.get(k) || 0) < n) { missing += n - (cg.get(k) || 0); if (missing <= 3) console.error("  missing comment:", JSON.stringify(k.slice(0, 90))); }
for (const [k, n] of cg) if ((cn.get(k) || 0) < n) { extra += n - (cn.get(k) || 0); if (extra <= 3) console.error("  extra comment:", JSON.stringify(k.slice(0, 90))); }
ok(missing === 0, `${missing} original comments missing from the modules`);
ok(extra === 0, `${extra} comments in the modules that were not in the original`);

// 3. chain
mods.forEach((m, i) => {
  const first = m.imports[0];
  if (i === 0) ok(!m.imports.some((n) => n.specifiers.length === 0), `${m.f}: first module has no side-effect import`);
  else ok(first && first.specifiers.length === 0 && first.source.value === `./${mods[i - 1].f}`, `${m.f}: first import is its predecessor ./${mods[i - 1].f}`);
  ok(m.imports.filter((n) => n.specifiers.length === 0).length === (i === 0 ? 0 : 1), `${m.f}: exactly one side-effect import`);
});

// 4 + 5. imports resolve, are used, are never assigned; no undeclared cross refs
const byFile = new Map(mods.map((m) => [m.f, m]));
const allTop = new Map(); // name -> file
for (const m of mods) for (const v of m.P.scope.globalScope.childScopes[0].variables) if (v.defs[0].type !== "ImportBinding") { ok(!allTop.has(v.name), `duplicate top-level name ${v.name}`); allTop.set(v.name, m.f); }
for (const m of mods) {
  const ms = m.P.scope.globalScope.childScopes[0];
  for (const v of ms.variables) {
    const d = v.defs[0];
    if (d.type !== "ImportBinding") continue;
    const spec = d.parent.source.value;
    ok(v.references.length > 0, `${m.f}: unused import ${v.name}`);
    ok(!v.references.some((r) => r.isWrite()), `${m.f}: assigns to import ${v.name}`);
    if (spec.startsWith("./")) {
      const tgt = byFile.get(spec.slice(2));
      ok(tgt && tgt.exports.has(d.node.imported.name), `${m.f}: ${spec} does not export ${d.node.imported.name}`);
      ok(allTop.get(v.name) === spec.slice(2), `${m.f}: ${v.name} imported from ${spec} but declared in ${allTop.get(v.name)}`);
    } else {
      ok(spec.startsWith("../lib/") && origImports.get(v.name) === posix.basename(spec), `${m.f}: unexpected import source ${spec} for ${v.name}`);
    }
  }
  for (const r of m.P.scope.globalScope.through) {
    const n = r.identifier.name;
    ok(origGlobals.has(n), `${m.f}: free identifier ${n} at line ${r.identifier.loc.start.line} is not a global of the original`);
    ok(!allTop.has(n), `${m.f}: uses ${n} (declared in ${allTop.get(n)}) without importing it`);
  }
}
// every export is imported somewhere (no dead exports generated)
for (const m of mods) for (const e of m.exports) {
  const used = mods.some((o) => o !== m && o.P.scope.globalScope.childScopes[0].variables.some((v) => v.name === e && v.defs[0].type === "ImportBinding"));
  ok(used, `${m.f}: export ${e} is imported nowhere`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : `split verified: ${got.length} top-level statements, ${gotComments.length} comments, ${mods.length} modules, chain intact`);
process.exit(failures ? 1 : 0);
