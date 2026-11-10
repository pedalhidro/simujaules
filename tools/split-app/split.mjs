// ONE-OFF TOOLING — how v82 split the monolithic app.js into app/*.js.
// Kept so the move can be re-derived and checked, not as part of any workflow.
//
// Reproduce (bb7e1b9 is the last commit with the single-file app.js):
//   mkdir /tmp/split && cd /tmp/split && npm i acorn eslint-scope
//   cp <repo>/tools/split-app/*.mjs <repo>/tools/split-app/plan.json .
//   git -C <repo> show bb7e1b9:app.js > app.monolith.js
//   node prep.mjs app.monolith.js app.prepared.js      # setters + 3 relocations
//   node split.mjs app.prepared.js plan.json out        # writes out/app.js, out/app/*.js
//   node verify-split.mjs app.prepared.js out plan.json # independent re-parse
//   diff -r out/app <repo>/app && diff out/app.js <repo>/app.js   # at the v82 commit
//
// The split is behaviour-preserving BY CONSTRUCTION:
//   - every module is a CONTIGUOUS slice of the prepared file, bytes verbatim;
//   - the only edits are generated `import` lines at the top and an `export `
//     prefix on top-level declarations another module references;
//   - each module's first import is its predecessor, and the entry imports the
//     last module, so top-level code runs in the original top-to-bottom order
//     (function declarations are hoisted across module cycles, exactly as they
//     were hoisted inside the single file).
// It refuses to run if a binding is assigned outside the module that declares
// it (ES imports are read-only) — prep.mjs adds the setters first.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join, posix } from "path";
import { analyze } from "./analyze.mjs";

const [srcPath, planPath, outDir] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const a = analyze(srcPath, plan.modules);
const { src, lines, mods, stmts, vars, uses, crossWrites } = a;

if (crossWrites.length) {
  console.error("cross-module writes (add setters first):");
  for (const w of crossWrites) console.error(`  ${w.name} (declared in ${w.def}) written in ${w.from} at line ${w.line}`);
  process.exit(1);
}

const WIDTH = 96;
function importLine(names, spec) {
  const one = `import { ${names.join(", ")} } from "${spec}";`;
  if (one.length <= WIDTH) return one;
  const out = ["import {"];
  let cur = " ";
  for (const n of names) {
    if (cur.length + n.length + 2 > WIDTH) { out.push(cur.trimEnd()); cur = " "; }
    cur += ` ${n},`;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  out.push(`} from "${spec}";`);
  return out.join("\n");
}

// Byte offset of the start of each line (0-based line index).
const lineOff = [0];
for (let i = 0; i < lines.length; i++) lineOff.push(lineOff[i] + lines[i].length + 1);

rmSync(join(outDir, "app"), { recursive: true, force: true });
mkdirSync(join(outDir, "app"), { recursive: true });

const importDecls = stmts.filter((s) => s.node.type === "ImportDeclaration");
const summary = [];

mods.forEach((m, i) => {
  // ---- body: the verbatim slice, minus the original import statements -------
  let bodyStartLine = m.start; // 1-based
  if (i === 0) {
    // Module 0 starts after the file header comment + original imports: the
    // header comment stays in the entry file. The plan gives the first line.
    const hits = [];
    lines.forEach((l, k) => { if (l.startsWith(plan.firstModuleStartsAt)) hits.push(k + 1); });
    if (!hits.length) throw new Error("firstModuleStartsAt matches no line");
    bodyStartLine = hits[0]; // the FIRST match: where the header comment ends
    for (const s of importDecls) if (s.node.loc.end.line >= bodyStartLine) throw new Error("import declaration below the first module's start");
    for (const s of stmts) if (s.node.type !== "ImportDeclaration" && s.node.loc.start.line < bodyStartLine) throw new Error("code above the first module's start");
  }
  const from = lineOff[bodyStartLine - 1], to = lineOff[m.end]; // [from, to)
  let body = src.slice(from, Math.min(to, src.length));

  // ---- exports: prefix declarations referenced from another module ----------
  const exported = [];
  const inserts = new Set();
  for (const v of vars.values()) {
    if (v.defMod !== i || v.importFrom) continue;
    let used = false;
    for (let j = 0; j < mods.length && !used; j++) if (j !== i && uses[j].has(v.name)) used = true;
    if (!used) continue;
    exported.push(v.name);
    if (!["FunctionDeclaration", "VariableDeclaration", "ClassDeclaration"].includes(v.stmt.type)) throw new Error(`cannot export ${v.name}: declared by a ${v.stmt.type}`);
    inserts.add(v.stmt.start);
  }
  for (const pos of [...inserts].sort((x, y) => y - x)) {
    const rel = pos - from;
    body = body.slice(0, rel) + "export " + body.slice(rel);
  }

  // ---- imports ---------------------------------------------------------------
  const byMod = new Map();   // module index -> names
  const byLib = new Map();   // rewritten specifier -> [{local, imported}]
  for (const [name] of uses[i]) {
    const v = vars.get(name);
    if (v.importFrom) {
      const spec = posix.normalize(posix.join("..", v.importFrom));
      const list = byLib.get(spec) || [];
      list.push(v.importedName === name ? name : `${v.importedName} as ${name}`);
      byLib.set(spec, list);
    } else if (v.defMod !== i) {
      const list = byMod.get(v.defMod) || [];
      list.push(name);
      byMod.set(v.defMod, list);
    }
  }
  const head = [];
  for (const l of m.desc) head.push(`// ${l}`.trimEnd());
  if (i > 0) head.push(`import "./${mods[i - 1].name}.js"; // evaluation order — see ../app.js`);
  for (const spec of [...byLib.keys()].sort()) head.push(importLine(byLib.get(spec).sort(), spec.startsWith(".") ? spec : `./${spec}`));
  for (const j of [...byMod.keys()].sort((x, y) => x - y)) head.push(importLine(byMod.get(j).sort(), `./${mods[j].name}.js`));

  const text = head.join("\n") + "\n\n" + body.replace(/\s+$/, "") + "\n";
  writeFileSync(join(outDir, "app", `${m.name}.js`), text);
  summary.push({ name: m.name, lines: text.split("\n").length - 1, exports: exported.length,
                 imports: [...byMod.values()].reduce((s, l) => s + l.length, 0), libs: byLib.size });
});

// ---- entry -------------------------------------------------------------------
const firstStmtLine = Math.min(...stmts.map((s) => s.node.loc.start.line));
let headerEnd = 0; // lines of the original header comment (before imports / first module)
while (headerEnd < lines.length && (lines[headerEnd].startsWith("//") || lines[headerEnd].trim() === "") && headerEnd + 1 < firstStmtLine && !lines[headerEnd].startsWith(plan.firstModuleStartsAt)) headerEnd++;
const header = lines.slice(0, headerEnd).join("\n").replace(/\s+$/, "");
const pad = Math.max(...mods.map((m) => m.name.length)) + 8;
const entry = [
  ...plan.entryHeader,
  "//",
  ...mods.map((m, i) => `//   ${String(i + 1).padStart(2)}  ${`app/${m.name}.js`.padEnd(pad)} ${m.short ?? m.desc[0]}`.trimEnd()),
  "",
  ...plan.entryChainComment,
  `import "./app/${mods[mods.length - 1].name}.js";`,
  "",
  ...plan.entryListComment,
  ...mods.slice(0, -1).map((m) => `import "./app/${m.name}.js";`),
  "",
].join("\n");
writeFileSync(join(outDir, "app.js"), entry);
writeFileSync(join(outDir, "split-summary.json"), JSON.stringify({ header, summary }, null, 1));
for (const s of summary) console.log(`${s.name.padEnd(18)} ${String(s.lines).padStart(5)} lines  exports ${String(s.exports).padStart(3)}  imports ${String(s.imports).padStart(3)}${s.libs ? `  (+${s.libs} lib)` : ""}`);
console.log(`total ${summary.reduce((s, x) => s + x.lines, 0)} lines in ${summary.length} modules (original ${lines.length})`);
