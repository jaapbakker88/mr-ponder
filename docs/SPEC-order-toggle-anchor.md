# Spec: keep your place when toggling order (`o`)

**Status:** DONE · **Priority:** P1 (small, high-annoyance papercut) · **Drafted:** 2026-08-27 · **Shipped:** 2026-08-31

Pressing `o` to flip between **risk order** (flat, highest-consequence-first —
read one chunk at a time in priority order) and **file order** (grouped, read a
file in place) currently throws away your position: the cursor snaps to the top
of the sidebar and the hunk scroll resets, even though the chunk you were
looking at is still right there in the reordered list. This spec makes `o`
**anchor on the currently focused chunk** across the reorder, so toggling order
mid-review doesn't cost you your spot.

## Problem

`src/ui.mjs:609`:

```js
else if (lc === "o") {
  setOrderMode((m) => (m === "risk" ? "file" : "risk"));
  setIdx(0);
  setScroll(0);
  flashMsg(...);
}
```

`orderMode` feeds the `visible` memo (`src/ui.mjs:199-223`), which re-sorts the
*same* chunk objects via `orderChunks` (`src/risk.mjs:149-162`) — it never drops
or clones chunks, only reorders them. So the chunk you had focused is always
still present in the new `visible` array, just at a different index. Resetting
`idx` to `0` (top of sidebar) and `scroll` to `0` (top of the hunk) throws that
away for no reason — annoying on any MR, actively disruptive on a large one
where "top" can be dozens of chunks away from where you were.

Note on terminology: informally this is "chunk order ↔ file order" — the two
`o` toggle states are named `risk`/`file` in code (`orderMode`) but the risk
mode reads chunk-by-chunk (flat), which is what "chunk order" refers to here.
This spec covers **both directions** of the toggle symmetrically.

## Design

Anchor on chunk **identity** (`chunk.id`, the existing stable
`file@oldStart:newStart` key — see `docs/README.md`'s architecture section),
not on index, since the index is exactly the thing that changes across a
reorder.

1. **Capture before switching.** In the `o` handler, stash the currently
   focused chunk's id (`chunk?.id`) in a ref before flipping `orderMode` —
   the state update is async, so the id must be captured from the pre-toggle
   closure, not read back out later.
   ```js
   const orderAnchor = React.useRef(null); // chunk id to re-find after an order toggle
   ...
   else if (lc === "o") {
     orderAnchor.current = chunk?.id ?? null;
     setOrderMode((m) => (m === "risk" ? "file" : "risk"));
     flashMsg(orderMode === "risk" ? "order: file (grouped, read in place)" : "order: risk (highest-consequence first)");
   }
   ```
   Drop the `setIdx(0)` / `setScroll(0)` calls — that's the papercut.

2. **Re-anchor after the reorder.** Add a `useEffect` keyed on `[orderMode,
   visible]` that, when `orderAnchor.current` is set, looks the id up in the
   freshly-reordered `visible` array and moves the cursor there:
   ```js
   useEffect(() => {
     if (orderAnchor.current == null) return;
     const target = visible.findIndex((c) => c.id === orderAnchor.current);
     orderAnchor.current = null;
     if (target >= 0) setIdx(target);
     // else: chunk no longer in `visible` (shouldn't happen for a pure
     // reorder, but a filter could theoretically race) — leave idx where
     // the existing safeIdx clamp (`ui.mjs:225,232-234`) puts it.
   }, [orderMode, visible]);
   ```
   This reuses the exact `findIndex`-by-id pattern `jumpFile` already uses
   (`ui.mjs:251-259`) — no new lookup primitive needed.

3. **Scroll position.** Since the anchored chunk is the *same* chunk (same
   hunk body, same content), leave `scroll`/`lineCur` untouched entirely —
   don't reset them on `o` at all. You were N lines into this hunk; you're
   still N lines into it after the sidebar reshuffles around it.

4. **Sidebar viewport.** No change needed beyond the above: `computeSidebarWindow`
   (`src/risk.mjs:179-196`) already centers the window on `curRowIdx`
   (`sidebarRowIndex`, `src/risk.mjs:170-173`) every render, so once `idx`
   lands on the right chunk, the visible sidebar window follows it
   automatically — same mechanism that already keeps the cursor on-screen
   during normal `j`/`k` navigation.

## Edge cases

- **No chunk focused** (empty `visible`, e.g. an over-narrow filter):
  `orderAnchor.current` is `null`, effect no-ops, existing empty-state
  handling is unaffected.
- **Chunk filtered out mid-toggle:** can't happen from `o` alone (it only
  changes sort order, not the filter predicates in the `visible` memo), so
  the `target < 0` branch is defensive, not expected to fire in practice.
- **Rapid double-`o`:** each press re-captures `chunk?.id` from that press's
  closure before the state update lands, so a fast risk→file→risk still ends
  on whatever chunk was focused at the *second* press, not a stale id from
  the first — consistent with how every other keypress handler already reads
  `chunk` from the current render's closure.

## Out of scope

- The other `setIdx(0)`/`setScroll(0)` resets on filter toggles (`u`/`s`/`d`/`e`,
  `ui.mjs:601-608`) are a *different* problem: those change *which chunks are
  in `visible` at all*, so "stay at the same spot" doesn't have an unambiguous
  meaning the way it does for a pure reorder (the focused chunk may no longer
  qualify). Not addressed here.
- No new state persisted to disk — `orderAnchor` is transient (a ref, not
  `state`), reset every toggle, never saved.

## Sequencing

1. Ref + capture-before-toggle in the `o` handler; drop the two resets.
2. `useEffect` re-anchor by id.
3. Manual verification: open a multi-file MR, focus a chunk partway down in
   risk order, scroll partway into its hunk, press `o` — cursor and scroll
   should both hold; press `o` again — same, back in risk order.

## Acceptance

Focus any chunk (not necessarily the first), scroll partway into its hunk
body, press `o`: the same chunk stays focused (sidebar highlight follows it,
scrolling into view if needed) and the hunk-pane scroll position is
unchanged. Holds in both directions (risk→file and file→risk) and repeatedly.
