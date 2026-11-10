// Tests for lib/changelog.js and the CHANGELOG.md it parses.
//
// CHANGELOG.md is the single source of the release history: the help modal
// fetches it at runtime and shows the blockquote under each `## vNN — date`
// heading. This checks that the real file stays well-formed for that (every
// entry has a digest, newest heading = sw.js VERSION, descending order) and
// that the renderer only ever emits escaped text plus <strong>/<em>/<code>.
//
//   node test-changelog.mjs

import { readFileSync } from "node:fs";
import { parseChangelog, renderInline } from "./lib/changelog.js";

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}`); }
}

const ALLOWED_TAG = /^<\/?(strong|em|code)>$/;
// Tags are allowed and properly nested; no stray < > outside them.
function wellFormed(html) {
  const stack = [];
  for (const m of html.matchAll(/<[^>]*>|[<>]/g)) {
    const tag = m[0];
    if (!ALLOWED_TAG.test(tag)) return false;
    const name = tag.replace(/[</>]/g, "");
    if (tag[1] === "/") { if (stack.pop() !== name) return false; }
    else stack.push(name);
  }
  return stack.length === 0;
}
// "v81" → 81, "v8–v10" → 10 (ranges compare by their upper bound).
const versionNum = (v) => Math.max(...(v.match(/\d+/g) || [NaN]).map(Number));

// 1. The real CHANGELOG.md.
{
  const md = readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8");
  const sw = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  const entries = parseChangelog(md);
  const swVersion = /const VERSION\s*=\s*"([^"]+)"/.exec(sw)?.[1];
  ok(entries.length >= 71, `CHANGELOG.md parses to ≥ 71 entries (${entries.length})`);
  ok(swVersion && entries[0]?.version === swVersion,
    `newest heading (${entries[0]?.version}) equals sw.js VERSION (${swVersion})`);
  const noQuote = entries.filter((e) => !e.fromBlockquote || !e.summaryHtml.trim());
  ok(noQuote.length === 0, `every entry has a non-empty blockquote summary${noQuote.length ? ": missing " + noQuote.map((e) => e.version).join(", ") : ""}`);
  const nums = entries.map((e) => versionNum(e.version));
  const badOrder = nums.findIndex((n, i) => i > 0 && !(n < nums[i - 1]));
  ok(nums.every(Number.isFinite) && badOrder < 0,
    `versions strictly descending${badOrder >= 0 ? ` (breaks at ${entries[badOrder].version})` : ""}`);
  const badHtml = entries.filter((e) => !wellFormed(e.summaryHtml));
  ok(badHtml.length === 0, `summaryHtml has only well-formed <strong>/<em>/<code>${badHtml.length ? ": " + badHtml.map((e) => e.version).join(", ") : ""}`);
  ok(entries.every((e) => /^\d{4}-\d{2}(-\d{2})?$/.test(e.date)), "every date is YYYY-MM(-DD)");
  const v12 = entries.find((e) => e.version === "v12");
  ok(v12 && v12.date === "2026-06-12" && v12.note === "(unreleased)", "heading suffix goes to `note`, not `date`");
}

// 2. Escaping and the inline subset.
{
  const h = renderInline('<script>alert("x")</script> & **bold** *em* `a<b>&c` "q"');
  ok(h === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; <strong>bold</strong> <em>em</em> <code>a&lt;b&gt;&amp;c</code> &quot;q&quot;',
    "HTML is escaped before markup; bold/em/code render");
  ok(wellFormed(h), "crafted input renders well-formed");
  const u = renderInline("an **unclosed bold and *em* here");
  ok(u === "an **unclosed bold and <em>em</em> here" && wellFormed(u), "unclosed ** stays literal, rest still renders");
  const x = renderInline("**a *b** c*");
  ok(wellFormed(x), `crossed delimiters still nest properly (${x})`);
  ok(renderInline("A* search, c* ≈ 1, 2 * 3") === "A* search, c* ≈ 1, 2 * 3", "space-flanked * is literal");
  ok(renderInline("c\\* and \\`x\\` and \\\\") === "c* and `x` and \\", "backslash escapes");
  ok(renderInline("`highway=*` and `*not em*`") === "<code>highway=*</code> and <code>*not em*</code>", "no markup inside code");
  ok(renderInline("a `lonely backtick") === "a `lonely backtick", "unclosed backtick is literal");
  ok(renderInline("line one\nline   two\n  three") === "line one line   two three", "wrapped lines join with one space");
}

// 3. Parser structure: blockquote, fallback, headings.
{
  const md = [
    "# Changelog", "", "Intro paragraph, not an entry.", "",
    "## v3 — 2026-01-03", "", "> **New.** Short", "> digest.", "", "Technical text.", "",
    "## v2 — 2026-01-02 (unreleased)", "", "### Fixes", "", "First *paragraph*", "wraps here.", "", "Second paragraph.", "",
    "## v1 — 2026-01-01", "",
  ].join("\n");
  const e = parseChangelog(md);
  ok(e.length === 3 && e.map((x) => x.version).join() === "v3,v2,v1", "entries in file order, intro skipped");
  ok(e[0].fromBlockquote && e[0].summaryHtml === "<strong>New.</strong> Short digest.", "blockquote becomes the summary");
  ok(!e[1].fromBlockquote && e[1].summaryHtml === "First <em>paragraph</em> wraps here.", "no blockquote → first paragraph (sub-heading skipped)");
  ok(e[1].date === "2026-01-02" && e[1].note === "(unreleased)", "date / note split");
  ok(e[2].summaryHtml === "" && !e[2].fromBlockquote, "empty entry → empty summary");
  ok(parseChangelog("## v1 — 2026-01-01\r\n\r\n> CRLF *ok*\r\n").at(0)?.summaryHtml === "CRLF <em>ok</em>", "CRLF input");
}

console.log(`\n${failed ? "FAIL" : "ALL PASS"} — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
