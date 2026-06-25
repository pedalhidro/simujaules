# Simujoules — academic presentation

A self-contained slide deck for an academic talk on **Simujoules**
(asymmetric-cost cycling energy fields over DEMs, in the browser), plus a
companion speaker-notes script.

| File | What it is |
|---|---|
| [`index.html`](./index.html) | The deck — [reveal.js](https://revealjs.com) loaded from CDN, on-brand dark theme, inline SVG diagrams. Open it in a browser. |
| [`SPEAKER-NOTES.md`](./SPEAKER-NOTES.md) | Per-slide script: timings, the exact numbers to cite, transitions, and anticipated Q&A. |
| `README.md` | This file. |

The deck deliberately mirrors the project's own philosophy: **no build step, no
bundler** — `index.html` pulls reveal.js from a CDN, exactly as the app pulls
its libraries.

## Present it

Open `docs/presentation/index.html` in any modern browser. Because the deck
loads reveal.js over HTTPS, the simplest path is just a file open; if your
browser blocks anything over `file://`, serve the repo root statically:

```sh
# from the repository root
python3 -m http.server 8000
# then open http://localhost:8000/docs/presentation/
```

### Controls

| Key | Action |
|---|---|
| `→` / `Space` | next slide · `←` previous |
| `↓` / `↑` | within a vertical sub-stack (slides 8 and 12–13 have them) |
| `S` | **speaker view** — current + next slide, notes, timer (opens a 2nd window; allow pop-ups) |
| `F` | fullscreen · `ESC` slide overview · `B` blank/black the screen |
| `?` | keyboard-shortcut help |

The deck has **19 top-level slides**; two of them (Methodology, the 2.5-D
problem + performance model) expand *downward* into sub-slides. Watch for the
down-arrow in the navigation control, or just press `Space` to walk everything
linearly.

## Export to PDF (for handouts / submission)

reveal.js prints via Chrome/Chromium. Append `?print-pdf` to the URL and use the
browser's "Save as PDF":

```
http://localhost:8000/docs/presentation/index.html?print-pdf
```

Then **File → Print → Destination: Save as PDF**, with *Background graphics*
**on** and margins **None**. (Headless alternative: `decktape reveal
"http://localhost:8000/docs/presentation/index.html" simujoules.pdf` if you have
[decktape](https://github.com/astefanutti/decktape).)

## Presenting fully offline

The deck needs network access once, to fetch reveal.js from jsDelivr. If you'll
present without internet, **vendor the four assets locally** and repoint the
tags in `index.html`:

```sh
cd docs/presentation
mkdir -p vendor/{dist,plugin/notes,plugin/highlight}
base=https://cdn.jsdelivr.net/npm/reveal.js@5.1.0
curl -L $base/dist/reset.css                  -o vendor/dist/reset.css
curl -L $base/dist/reveal.css                 -o vendor/dist/reveal.css
curl -L $base/dist/reveal.js                  -o vendor/dist/reveal.js
curl -L $base/plugin/notes/notes.js           -o vendor/plugin/notes/notes.js
curl -L $base/plugin/highlight/highlight.js   -o vendor/plugin/highlight/highlight.js
curl -L $base/plugin/highlight/monokai.css    -o vendor/plugin/highlight/monokai.css
```

Then replace the five `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/...` URLs in
`index.html` with the matching `./vendor/...` paths. (All diagrams, fonts, and
the theme are already inline, so nothing else needs vendoring.)

## Editing

- **Content** lives entirely in the `<section>` elements of `index.html`. Each
  slide's embedded `<aside class="notes">` is a short version of the matching
  section in `SPEAKER-NOTES.md` — if you change a claim, update both.
- **Theme** (colours, fonts, equation/card styling) is the single `<style>`
  block at the top; the palette matches the app (`--bg #0f1115`,
  `--accent #ff8c42` uphill/warm, `--accent-2 #4cc9f0` downhill/cool).
- **Diagrams** are hand-written inline `<svg>` — no image files to manage.

## Provenance & accuracy

Every figure in the deck is sourced from this repository: `README.md`,
`CHANGELOG.md`, `CLAUDE.md`, `llms.txt`, `performance-formula.md`,
`docs/runtime_estimate.md`, `docs/bridges-and-passability.md`, the engines
(`energy-worker.js`, `graph-engine.js`, `backend/src/main.rs`), and the test
suites. The headline numbers (the cost model, the 135 M-cell ceiling, the
Av. Dr. Arnaldo viaduct verification, the 426-vs-427 s performance-model
validation, the bit-parity thresholds) are quoted from those files — see
[`SPEAKER-NOTES.md` → "Numbers to have ready"](./SPEAKER-NOTES.md#numbers-to-have-ready).

> **Note — the deck is *not* deployed by `deploy.sh`.** Only the explicitly
> listed app files ship to `gs://telhas/simujoules`; `docs/` (like `backend/`
> and the test harnesses) is repo-only. This presentation stays local.
