// Phase-1 fix fleet for docs/review-2026-07-02-round2-workorder.md.
//
// Not auto-run — invoke explicitly via the Workflow tool:
//   Workflow({ scriptPath: "tools/phase1-fix-fleet.workflow.js" })
//
// Implements the 11 Phase-1 lanes from the work order: the six app.js lanes
// run as a SEQUENTIAL pipeline (they share one file); the five other lanes
// run in PARALLEL with each other and with the app.js pipeline (disjoint
// files). Do NOT add the Phase-2 "LARGE" aero-taper item here — it touches
// the same files as LANE-WORKER/LANE-GRAPH/LANE-BACKEND and must run alone,
// sequentially, after this batch is committed (see the work order's Phase 2
// section). VERSION/CHANGELOG.md/index.html-changelog are deliberately NOT
// touched by any lane here — bump those once, centrally, after this whole
// batch lands (Phase 3 in the work order).

export const meta = {
  name: 'phase1-fix-fleet',
  description: 'Implement the 78-finding round-2 review work order (Phase 1 lanes only)',
  phases: [
    { title: 'app.js pipeline', detail: '6 sequential stages (AJS-1..AJS-6)' },
    { title: 'Parallel lanes', detail: 'worker / graph / backend / cloud / docs-misc' },
  ],
}

const REPO_DOC = 'docs/review-2026-07-02-round2-workorder.md'

const COMMON =
  'You are implementing fixes from the Sonnet work order at ' + REPO_DOC + ' in this repo ' +
  '("Simujaules" / sampasimu — a static PWA computing cycling energy fields over DEMs; JS worker ' +
  'engine + Rust backend that must stay bit-parity). Read that file FIRST, in full, then read ' +
  'CLAUDE.md for the binding project invariants. Find the section matching your assigned lane ' +
  '(a "## LANE-..." or "## AJS-..." heading) and implement EVERY finding listed under it, in the ' +
  'order given, following each finding\'s "Fix approach" exactly (grep to confirm the current line ' +
  'number first — the file has moved since the review). Respect each finding\'s "Invariants — do ' +
  'not break" line. If a finding\'s adversarial re-check flagged the fix spec as incomplete ' +
  '(marked with a ⚠️ amendment), apply the amendment too, not just the original approach.\n\n' +
  'HARD RULES:\n' +
  '- Touch ONLY the files your lane owns (stated in the lane\'s "**Files:**" line). Other lanes ' +
  'run concurrently against other files — touching a file you do not own will corrupt their work.\n' +
  '- Do NOT bump sw.js VERSION. Do NOT edit CHANGELOG.md. Do NOT edit index.html\'s ' +
  '<details id="changelog">. That is centralized after every lane lands — not your job.\n' +
  '- Do NOT run any git command that mutates state (no add/commit/stash).\n' +
  '- New UI-visible strings go through the STRINGS table + t() with BOTH pt and en entries — never ' +
  'hardcode display text.\n' +
  '- Match surrounding code style exactly (comment density/language, naming).\n' +
  '- After editing, run the "Tests to run" listed for each finding you touched, plus `node --check ' +
  '<file>` (or `bash -n` / `cargo build --release` as appropriate) on every file you touched. ' +
  'Iterate until green.\n' +
  '- If a finding turns out to not apply any more (code already changed), or you deliberately skip ' +
  'part of it, say so honestly in concerns — do not silently drop it.\n' +
  '- Your final message is consumed by a program; return exactly the schema.\n\n'

const FIX_REPORT = {
  type: 'object',
  required: ['summary', 'changes', 'testsRun', 'concerns'],
  properties: {
    summary: { type: 'string', description: '3-6 sentences: what was fixed and how' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'what'],
        properties: { file: { type: 'string' }, what: { type: 'string' } },
      },
    },
    testsRun: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'passed', 'note'],
        properties: { name: { type: 'string' }, passed: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
    concerns: { type: 'string', description: 'deferred/skipped/risky items; "none" if none' },
  },
}

// The six app.js lanes MUST run sequentially (pipeline, not parallel) — they
// share one file. Each stage's prompt names its own lane heading.
const AJS_STAGES = ['AJS-1', 'AJS-2', 'AJS-3', 'AJS-4', 'AJS-5', 'AJS-6']

// These five run in parallel with each other AND with the whole AJS pipeline
// — each owns a disjoint set of files.
const PARALLEL_LANES = ['LANE-WORKER', 'LANE-GRAPH', 'LANE-BACKEND', 'LANE-CLOUD', 'LANE-DOCS-MISC']

function lanePrompt(lane) {
  return COMMON + 'YOUR LANE: "## ' + lane + '" in ' + REPO_DOC + '. Implement every finding under ' +
    'that heading (stop before the next "## " heading).'
}

log('Starting AJS-1..AJS-6 sequentially, plus 5 parallel lanes')

const [ajsResults, laneResults] = await parallel([
  () => pipeline(
    AJS_STAGES,
    (stage) => agent(lanePrompt(stage), { label: 'fix:' + stage, phase: 'app.js pipeline', schema: FIX_REPORT }),
  ),
  () => parallel(
    PARALLEL_LANES.map((lane) => () =>
      agent(lanePrompt(lane), { label: 'fix:' + lane, phase: 'Parallel lanes', schema: FIX_REPORT })
    ),
  ),
])

const ajsByStage = Object.fromEntries(AJS_STAGES.map((s, i) => [s, ajsResults[i]]))
const laneByName = Object.fromEntries(PARALLEL_LANES.map((l, i) => [l, laneResults[i]]))

log('Phase 1 complete. Next: run the full test sweep, then Phase 2 (LARGE aero-taper item, ' +
    'alone, sequentially), then Phase 3 (centralize VERSION + changelog + adversarial diff review).')

return { ajs: ajsByStage, lanes: laneByName }
