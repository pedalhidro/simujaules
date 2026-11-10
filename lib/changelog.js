// CHANGELOG.md parser for the help modal's collapsed Changelog section.
//
// CHANGELOG.md is the single source of the release history. Each entry is a
// `## vNN — date` heading; the Markdown blockquote directly under it is the
// short user-facing summary the app shows, and everything after it is the
// technical detail for GitHub readers. This module is PURE (no DOM, no
// fetch): it runs unchanged in the browser (app.js imports it) and in Node
// (test-changelog.mjs).
//
// Only the inline subset the summaries actually use is rendered:
// **bold**, *em*, `code`, and the backslash escapes \* \` \\ . The text is
// HTML-escaped (& < > ") BEFORE any markup is applied, so the only tags that
// can ever appear in summaryHtml are <strong>, <em> and <code>, always
// properly nested; an unmatched delimiter stays literal text.

const HEADING_RE = /^## (\S+)\s+—\s+(.*?)\s*$/;

/** Escape the four HTML-significant characters (& first). */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const isSpace = (c) => c === undefined || /\s/.test(c);

/**
 * Render one paragraph of the inline subset to safe HTML. Lines are joined
 * with single spaces. Delimiters follow a simplified flanking rule: an
 * opener must be followed, and a closer preceded, by a non-space character.
 */
export function renderInline(md) {
  const src = escapeHtml(String(md).split(/\r?\n/).map((l) => l.trim()).join(" ").trim());
  // 1. Tokenize into text / code / delimiter runs.
  const toks = [];
  const text = (s) => {
    const last = toks[toks.length - 1];
    if (last && last.t === "text") last.s += s;
    else toks.push({ t: "text", s });
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "\\" && (src[i + 1] === "*" || src[i + 1] === "`" || src[i + 1] === "\\")) {
      text(src[i + 1]);
      i += 2;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) { text("`"); i += 1; continue; }
      toks.push({ t: "code", s: src.slice(i + 1, j) });
      i = j + 1;
    } else if (c === "*") {
      const n = src[i + 1] === "*" ? 2 : 1;
      toks.push({
        t: "delim",
        n,
        open: !isSpace(src[i + n]),
        close: !isSpace(src[i - 1]),
        match: null,
      });
      i += n;
    } else {
      text(c);
      i += 1;
    }
  }
  // 2. Pair delimiters with a stack; closing pops down to the matching
  //    opener, discarding any openers in between (they render literally),
  //    which guarantees properly nested output.
  const stack = [];
  for (let k = 0; k < toks.length; k++) {
    const d = toks[k];
    if (d.t !== "delim") continue;
    let paired = false;
    if (d.close) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]].n === d.n) {
          toks[stack[s]].match = "open";
          d.match = "close";
          stack.length = s;
          paired = true;
          break;
        }
      }
    }
    if (!paired && d.open) stack.push(k);
  }
  // 3. Emit.
  let out = "";
  for (const tk of toks) {
    if (tk.t === "text") out += tk.s;
    else if (tk.t === "code") out += `<code>${tk.s}</code>`;
    else {
      const tag = tk.n === 2 ? "strong" : "em";
      if (tk.match === "open") out += `<${tag}>`;
      else if (tk.match === "close") out += `</${tag}>`;
      else out += "*".repeat(tk.n);
    }
  }
  return out;
}

/**
 * Parse CHANGELOG.md into entries, in file order:
 *   { version, date, note, summaryHtml, fromBlockquote }
 * `date` is the first token after the em dash ("2026-06-19"); `note` is any
 * remainder ("(unreleased)"). `summaryHtml` renders the blockquote under the
 * heading or, when there is none, the entry's first plain paragraph
 * (`fromBlockquote` is false then).
 */
export function parseChangelog(md) {
  const lines = String(md).split(/\r?\n/);
  const entries = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    const body = cur.body;
    let i = 0;
    while (i < body.length && body[i].trim() === "") i++;
    let para = [];
    let fromBlockquote = false;
    if (i < body.length && /^>/.test(body[i])) {
      fromBlockquote = true;
      for (; i < body.length && /^>/.test(body[i]); i++) para.push(body[i].replace(/^> ?/, ""));
    } else {
      // Fallback: the first paragraph that is not a sub-heading / blockquote.
      for (; i < body.length; i++) {
        const l = body[i];
        if (l.trim() === "") { if (para.length) break; continue; }
        if (/^#{1,6}\s/.test(l) || /^>/.test(l)) { if (para.length) break; continue; }
        para.push(l);
      }
    }
    entries.push({
      version: cur.version,
      date: cur.date,
      note: cur.note,
      summaryHtml: renderInline(para.join("\n")),
      fromBlockquote,
    });
    cur = null;
  };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && HEADING_RE.exec(line);
    if (m) {
      finish();
      const [date, ...rest] = m[2].split(/\s+/);
      cur = { version: m[1], date, note: rest.join(" "), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  finish();
  return entries;
}
