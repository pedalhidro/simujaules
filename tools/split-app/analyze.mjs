// Shared analysis for the app.js split: parse, resolve module-scope bindings,
// map every top-level statement and every reference to a module of the plan.
import { readFileSync } from "fs";
import * as acorn from "acorn";
import * as eslintScope from "eslint-scope";

export function analyze(srcPath, plan) {
  const src = readFileSync(srcPath, "utf8");
  const lines = src.split("\n");
  const comments = [];
  const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", ranges: true, locations: true, onComment: comments });
  const sm = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: "module" });
  const moduleScope = sm.globalScope.childScopes[0];

  // Resolve plan anchors (unique line prefixes) to 1-based start lines.
  const mods = plan.map((m, i) => {
    let start;
    if (i === 0) start = 1;
    else {
      const hits = [];
      lines.forEach((l, k) => { if (l.startsWith(m.anchor)) hits.push(k + 1); });
      if (hits.length !== 1) throw new Error(`anchor for ${m.name} matches ${hits.length} lines: ${JSON.stringify(m.anchor)} ${hits.join(",")}`);
      start = hits[0];
    }
    return { ...m, start };
  });
  for (let i = 1; i < mods.length; i++) if (mods[i].start <= mods[i - 1].start) throw new Error(`plan out of order at ${mods[i].name}`);
  mods.forEach((m, i) => { m.end = i + 1 < mods.length ? mods[i + 1].start - 1 : lines.length; });
  const modOfLine = (ln) => { let k = 0; for (let i = 0; i < mods.length; i++) if (ln >= mods[i].start) k = i; return k; };

  // No top-level statement may straddle a cut.
  const stmts = ast.body.map((n) => ({ node: n, mod: modOfLine(n.loc.start.line) }));
  for (const s of stmts) if (modOfLine(s.node.loc.end.line) !== s.mod) throw new Error(`statement at ${s.node.loc.start.line}-${s.node.loc.end.line} straddles a cut`);
  const stmtOfPos = (pos) => stmts.find((s) => pos >= s.node.start && pos < s.node.end);

  const vars = new Map(); // name -> { name, defMod, stmt, kind, importFrom }
  const uses = mods.map(() => new Map()); // mod -> name -> { reads, writes }
  const crossWrites = [];
  for (const v of moduleScope.variables) {
    const def = v.defs[0];
    const st = stmtOfPos(def.name.start);
    const info = { name: v.name, defMod: st.mod, stmt: st.node, type: def.type,
                   kind: def.type === "Variable" ? def.parent.kind : def.type,
                   importFrom: def.type === "ImportBinding" ? def.parent.source.value : null,
                   importedName: def.type === "ImportBinding" ? (def.node.imported?.name ?? "default") : null };
    vars.set(v.name, info);
    for (const r of v.references) {
      const ln = src.slice(0, r.identifier.start).split("\n").length; // fine: few thousand refs
      const m = modOfLine(ln);
      const u = uses[m].get(v.name) || { reads: 0, writes: 0 };
      if (r.isWrite() && !r.init) { u.writes++; if (m !== info.defMod) crossWrites.push({ name: v.name, line: ln, from: mods[m].name, def: mods[info.defMod].name }); }
      else u.reads++;
      uses[m].set(v.name, u);
    }
  }
  const globals = new Map();
  for (const r of sm.globalScope.through) globals.set(r.identifier.name, (globals.get(r.identifier.name) || 0) + 1);
  return { src, lines, ast, comments, mods, stmts, vars, uses, crossWrites, globals, modOfLine };
}
