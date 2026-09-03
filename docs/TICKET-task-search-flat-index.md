# Ticket: search navigation — flat match index (task)

Type: task · Status: **done** · Blocked by: none

## Resolution

`n`/`N` now steps through a flat list of `(chunkIdx, bodyIdx)` pairs — one
entry per matching line — rather than jumping between matching chunks.

### Changes shipped

**`src/ui.mjs`**
- `flatMatchIdx` state + `flatNavRef` ref (guards the reset effect from
  fighting n/N navigation).
- `flatMatches` useMemo: iterates `visible`, skips `body[0]` (@@ header) and
  removed lines (`-` prefix), emits one entry per matching eligible line.
- Reset `useEffect` on `[safeIdx, pattern, flatMatches]`: positions
  `flatMatchIdx` at the first match in the current chunk; skips when n/N
  triggered the chunk change.
- n/N handler replaced: computes centred `targetScroll` from `bodyIdx` and
  `bodyH`; sets `flatMatchIdx`, `idx`, and `scroll` atomically.
- `flatTotal`, `matchesInChunk`, `chunkMatchIdx` derived values exposed for
  the search status panel (see `TICKET-grilling-search-status-panel.md`).

**`tests/flat-match.test.mjs`** — 19 tests covering `buildFlatMatches`,
  `targetScroll` centering math, wrap-around arithmetic, and `chunkMatchIdx`.
