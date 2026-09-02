# Ticket: search navigation — flat match index (task)

Type: task · Status: open · Blocked by: none

## Question

Redesign `n`/`N` to iterate over a flat list of `(chunkIdx, lineIdx)` pairs so it jumps to the exact match *instance*, not just the next matching chunk.

## Work to do

Current state (`src/ui.mjs:718–730`):
- `visible` = chunks filtered to those containing the pattern.
- `n`/`N` steps `safeIdx` through `visible` — chunk level only.
- `setScroll(0)` resets to top of chunk; if the match is below the fold the user must scroll.

Required changes:

1. **Build a flat match list** alongside `visible`. In the same `useMemo` that builds `visible` (lines 298–327), also emit a flat array: `[ { chunkIdx, lineIdx }, … ]` — one entry per matching line across all visible chunks.

2. **Replace `safeIdx` navigation with flat-index navigation** when a pattern is active:
   - `n` → increment flat index (wrapping)
   - `N` → decrement flat index (wrapping)
   - On each step: `setIdx(chunkIdx)` + `setScroll(lineIdx - Math.floor(bodyH/2))` (clamped) to centre the matched line in the viewport.

3. **Keep chunk-level navigation** (`j`/`k`, sidebar clicks) unchanged; the flat index is only used while a pattern is active and resets to the first match of the current chunk when the pattern is cleared or changed.

4. **Wire into search status panel** (see sibling ticket) — expose `{ flatIdx, flatTotal, matchesInChunk, chunkMatchIdx }` for the panel to render.

## Resolution

*(to be filled in)*
