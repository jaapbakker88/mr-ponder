# BUG: sidebar corrupts below the cursor in file order (large MRs)

**Status:** RESOLVED. Root cause confirmed via raw-ANSI capture; fix applied
and verified on WezTerm/Windows against the reference MR by the reporter.

## Resolution

**Root cause:** structural instability in the sidebar's rendered row list.
The "↑ N more" / "↓ N more" affordance rows were conditionally inserted only
once the scroll window first needed them — i.e. on the very first frame
where the cursor scrolled far enough in, a brand-new keyed element appeared
in the tree that had never existed in any prior frame.

Proven via two independent ground-truth captures (not inferred):

1. **`MRP_DEBUG` model trace** — the row model (`allRows`, `curRowIdx`,
   `start`/`end`) was correct on every single frame, including the broken
   one. Confirmed the bug is not in the data/windowing model (consistent
   with the "PROVEN correct" section below).
2. **Raw ANSI capture (`script(1)`)** — every frame in a full scrolling
   session had exactly 74 embedded newlines, 19 frames straight, zero
   variance, until the exact frame where the "↑ 1 more" row first appeared.
   That one frame emitted 76 newlines instead of 74. Ink's terminal writer
   (`log-update.js`, bundled in `ink@5.2.1`) erases the terminal based
   solely on the *previous* frame's line count and never re-verifies what
   the terminal actually shows — so that one-time shape change permanently
   desynced the erase/cursor bookkeeping for every frame after it. This is
   also why the raw bytes for that one frame contained the literal
   corruption: `"↑ 1 more"` and a fragment of the sidebar title
   (`"h · order:file"`) were concatenated on the same line with no newline
   between them, in Ink's own output string — not a terminal paint issue.

This also explains every reported symptom: always the same spot for a given
MR + terminal size (deterministic: whichever row first needs a "more" row),
moves after a resize (that row is a function of `sidebarH`/`cols`), and
never self-heals (log-update has no correction mechanism once desynced).

Two contributing factors that made the bug easier to trigger (fixed along
the way, real defects independent of the root cause):

- Every arrow-key press was producing **two** full-height Ink repaints
  instead of one, from two independent effects that each fired a second
  React commit after the one that moved the cursor: a `useEffect` resetting
  `lineCur`/`selAnchor` keyed on `chunk.id`, and a `useEffect` calling
  `persist()` (setState + synchronous disk write) for auto-engagement.
  Both were folded into the same commit as the cursor move (the first via
  React's "adjust state during render" pattern; the second the same way,
  with the disk write deferred to a plain effect that never calls setState).

**Fix:** the "↑ more"/"↓ more" rows are now always-mounted, fixed-position
elements (blank when not needed) instead of being conditionally inserted,
so their first-appearance can never happen again — see `src/ui.mjs`, the
sidebar windowing block right after `computeSidebarWindow`.

**Ruled out along the way, with hard evidence (not assumption), before
finding the actual cause:**
- Raw control characters (ESC, TAB, etc.) leaking from diff content into
  labels — scanned all 142 real chunks' `context` and `body` from the reference MR:
  zero.
- Unbalanced inverse SGR (`\x1b[7m` without a matching off) bleeding across
  a line break — scanned the full raw ANSI capture: zero occurrences.
- Any rendered line's visible width exceeding the terminal's column count
  (terminal-side auto-wrap) — scanned every frame: max width seen equaled
  `cols` exactly, never exceeded.
- The manual alt-screen buffer (`MRP_NO_ALT=1` test) — corruption persisted
  without it, ruling out the alt-screen + full-height combo.

## Original report (kept for history)

Running against a large MR (reproduces reliably on **the reference MR**), in **file
order** (`o`), scroll down until the cursor is well into the list. Observed:

- The **highlighted (current) row is the last row that renders correctly.**
- **Everything below the cursor is garbage**: file-header rows appear back-to-back
  with their chunk row missing, chunks appear under the wrong file header
  ("chunks moving from file to file"), the layout is "completely foo".
- Everything **at and above** the cursor looks fine.

Screenshot evidence (user's, WezTerm/Windows): a cropped sidebar showing e.g.
`<Section>` header immediately followed by
`<TableDefinition>` header with the Receivables **chunk row
missing** between them. Colors (new sidebar color-coding) are present, so the
screenshot IS the current build.

## Environment

- Terminal: **WezTerm on Windows** (native, NOT tmux, NOT opencode, NOT a
  multiplexer). No resize occurs during the session.
- Ink 5.2.1, React 18.3.1, Node (ESM, no build step).
- `stdout.rows` reported ~75 in the real session (`sidebarH:72`) — this is the
  user's actual window height; it is NOT a wrong/stale size.
- Full-screen: mrp enters the **alternate screen buffer** (`\x1b[?1049h`) in
  `mrp.mjs`, and the app renders at `height: appH = rows - 1`.

## What is PROVEN correct (do not re-investigate these)

1. **Chunk ids are unique.** the reference MR: 142 chunks, 142 distinct ids. No React key
   collisions from duplicate ids.
2. **The row model (`allRows`) is correct and stable.** Reproduced headless with
   real <iid> data: every file header is immediately followed by its own chunk
   rows; grouping is contiguous; `orderChunks(chunks,"file")` is stable across
   calls. See the repro approach in the "Repro harness" section.
3. **The windowing math is correct.** `sidebarRowIndex` + `computeSidebarWindow`
   (pure, in `src/risk.mjs`, unit-tested in `tests/risk.test.mjs`) always return a
   window containing the current chunk's row, at every cursor position, and
   `curRowIdx` lands on the chunk row, never the file header. 5 regression tests
   cover this.

Conclusion: the data/model/window are right. **The corruption is in the terminal
render layer** (Ink painting the wrong thing), and it is terminal-specific
(never reproduced in headless `ink` renders piped through `sed`).

## Fixes ATTEMPTED that did NOT work (do not repeat)

1. **Header/chunk id disambiguation** — header rows carried `headerFor` instead of
   `chunkId` so the cursor lookup can't match a header. (Correct fix for a real
   one-row-off centering bug, and kept — but did NOT fix the corruption.)
2. **`overflow: "hidden"`** on the `cols` row, sidebar box, and right pane. No
   change.
3. **Render one line short** (`appH = rows - 1`) to avoid Ink's trailing-newline
   scroll desync. User initially said "seems to work" but the corruption returned
   — so this was NOT the fix (or only masked it transiently). Kept anyway; it's
   defensible.
4. **Width/wrap margin** — introduced `sidebarInner = sidebarW - 5` and re-derived
   every sidebar slice (chunk label `-8`, file-mode label `-10`, header `-2`) so
   no row can reach the exact wrap threshold. Hypothesis: a full-width row wraps to
   a 2nd line and desyncs Ink's row accounting. No change.
5. **Color-bleed fix** — the current (inverse) row nested per-cell colored `<Text>`
   (marks) and a colored label inside an `inverse` parent; hypothesized Ink 5
   emits resets that don't clear `inverse`, bleeding onto rows below. Made the
   current row render uniform/plain (no nested colors) via `chunkMarkEls(c,dim,plain)`
   and dropped label color when `isCur`. No change. **This is the strongest
   remaining hypothesis by symptom ("last good row is the cursor, everything below
   is foo" = classic un-reset SGR state), but the specific fix tried didn't work —
   the reset may be leaking from a different node (the caret, the risk glyph, or
   the `inverse` prop itself), or Ink is mis-diffing the moved inverse region.**

## Leading hypotheses for the fresh session (in priority order)

1. **SGR/inverse state not reset after the current row** (strongest — matches the
   "everything below the cursor is foo" signature exactly). The color-bleed fix
   targeted the marks+label but the leak may come from:
   - the `inverse: isCur` prop on a `<Text>` that also has colored siblings;
   - the risk-glyph `<Text>` (colored, sibling of the inverse block);
   - Ink 5's diff of the *moved* inverse region between frames (previous cursor row
     vs new one) on the alt screen.
   Next step: capture the **raw ANSI** Ink writes for the frame (not a headless
   sed-stripped capture) and look for an unbalanced `\x1b[7m` (inverse on) without
   a matching `\x1b[27m` (inverse off) before the newline, or a `\x1b[7m` that
   spans into the next row.
2. **Alt-screen interaction.** `MRP_NO_ALT=1` env toggle was added to `mrp.mjs`
   (disables `\x1b[?1049h`). ASK THE USER TO TEST `MRP_NO_ALT=1 mrp <iid>` FIRST —
   if it fixes it, the bug is the alt-screen + tall-frame + Ink combo, and the fix
   is to drop the manual alt-screen (let Ink manage the screen) or stop rendering
   full-height.
3. **Ink can't reliably paint a frame whose height ≈ terminal rows on WezTerm.**
   The frame is ~74 lines tall in a ~75-row terminal. Consider NOT filling the
   full height — cap total rendered rows well under `rows` and see if corruption
   stops. If so, the "full-height takeover" feature is the root cause and needs
   rethinking (maybe render the sidebar with a hard row cap independent of `rows`).

## How to get ground truth (do this FIRST in the fresh session)

The headless render harness (render to a piped stdout, strip ANSI with sed) does
NOT reproduce the bug — it's terminal-specific. You MUST capture from a real run.

Option A — **per-render trace to a log** (worked once before; the `require()` in
ESM was the reason a later attempt produced no log — use the static
`import { appendFileSync }` instead):

Add, right after the sidebar window is computed in `src/ui.mjs`
(after `const { start, end, above, below } = computeSidebarWindow(...)`):

```js
import { appendFileSync } from "node:fs"; // at top, with the other fs imports
// ...
if (process.env.MRP_DEBUG) {
  try {
    appendFileSync(process.env.MRP_DEBUG, JSON.stringify({
      t: Date.now(), cols, rows, appH, sidebarW, sidebarH, bodyH,
      orderMode, idx, safeIdx, chunkId: chunk?.id,
      total, curRowIdx, start, end, above, below,
      renderedRows: sidebarRows.length,
      winRows: allRows.slice(start, end).map(r =>
        r.chunkId ? "C:" + r.chunkId.split("/").pop()
                  : "H:" + (r.headerFor||"").split("/").pop()),
    }) + "\n");
  } catch (e) { appendFileSync(process.env.MRP_DEBUG, "ERR " + e.message + "\n"); }
}
```

Then have the user run: `MRP_DEBUG=/tmp/mrp.log mrp <iid>`, press `o`, scroll into
<Feature> until it breaks, `q`. Read `/tmp/mrp.log`. This tells you what
the MODEL fed Ink (expected: correct) vs what the screen SHOWS (corrupt) — proving
it's Ink's paint, and pinning the exact frame.

NOTE: env vars must reach the process. `mrp` is a symlink to
`~/work/mr-ponder/mrp.mjs`; `MRP_DEBUG=... mrp <iid>` should pass through, but
verify the file is created (a prior attempt produced no log — likely the ESM
`require()` threw and was swallowed; the static import above avoids that).

Option B — **capture raw ANSI**: `script -c 'mrp <iid>' /tmp/mrp.typescript` (or
WezTerm's own logging), reproduce, then inspect `/tmp/mrp.typescript` for
unbalanced SGR (`\x1b[7m` without `\x1b[27m`) around the cursor row.

## Repro harness (headless — proves model is correct, does NOT show the bug)

```js
// from repo root, node _repro.mjs
import { fetchMrChanges } from "./src/gitlab.mjs";
import { parseChanges } from "./src/diff.mjs";
import { scoreChunks, riskOrder, orderChunks, sidebarRowIndex, computeSidebarWindow } from "./src/risk.mjs";
import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const changes = await fetchMrChanges("<group>/<project>", "<iid>");
const chunks = riskOrder(await scoreChunks(parseChanges(changes), mkdtempSync(join(tmpdir(),"r-"))));
const visible = orderChunks(chunks, "file");
// build allRows (header row per file + chunk rows), then window + print — see git history.
```

## Relevant code

- `src/ui.mjs` — sidebar build (`allRows`), windowing, `chunkMarkEls`,
  `labelColor`, the two row renderers (risk mode / file mode), the final `<Box>`
  layout (`appH`, `overflow:hidden`).
- `src/risk.mjs` — `sidebarRowIndex`, `computeSidebarWindow` (pure, tested).
- `mrp.mjs` — alt-screen enter/leave, `MRP_NO_ALT` toggle, full-height render.
- `tests/risk.test.mjs` — windowing regression tests.

## Acceptance

In WezTerm on Windows, `mrp <iid>` → `o` → scroll through all
<Feature> files: every file header is followed by its own chunk
rows, the cursor row and all rows below it render correctly, no chunk appears
under the wrong file, no header appears without its chunks.
