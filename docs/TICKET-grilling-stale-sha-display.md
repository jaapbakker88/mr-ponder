# Ticket: stale-SHA warning — display design (grilling)

Type: grilling · Status: closed

## Question

How should the stale-SHA warning be presented inside the running TUI?

The warning text is:
```
⚠ this MR was updated since your last review (head SHA changed).
  6 annotated chunk(s) no longer match the current diff.
  31 new/changed chunk(s) since last review — press 'd' to review just the delta.
  Your notes are preserved but may point at shifted lines.
```

Options on the table:
- **A — Persistent dismissable banner**: insert a coloured top strip (above or below the existing header bar) that stays until the user explicitly dismisses it (e.g. with `Esc` or a dedicated key). Keeps the warning in view without it auto-expiring.
- **B — Long-lived flash**: mount hook triggers `flashMsg(…)` with a much longer timeout (e.g. 8–10 s). Simple, but the footer is already busy and the warning text is multi-line — the footer is one line.
- **C — Header indicator + expandable**: add a `⚠` badge or `[MR updated]` to the header right side; pressing a key (e.g. `?` or a new key) shows/hides the full warning text as a modal/overlay.
- **D — One-time overlay on first keypress**: show the full warning text as a blocking overlay when the TUI first renders, dismissed by any keypress (similar to the help modal). Interrupts flow but guarantees the user sees it.

Open sub-questions:
1. Should pressing `d` (jump to delta) also dismiss the banner/overlay?
2. Does the warning need to remain accessible after dismissal, or is a one-shot display enough?
3. Multi-line vs single-line: the existing header/footer are single-line; option A requires adding a dedicated row.

## Resolution

**Option C — Header badge + expandable overlay.**

- Badge `⚠ +N ~M` prepended on the header right side (before existing counters). `+N` = `newIds.length`, `~M` = `orphaned.length`. Data already computed at `mrp.mjs:131–138`; thread it as props into the `App` component.
- `!` opens a full-screen overlay (same style as the help modal) showing the full four-line warning text.
- Closing the overlay (any key) removes the badge from the header for the rest of the session (one-shot).
- Pressing `d` anywhere while the badge is visible also removes the badge and jumps to delta mode (whether overlay is open or not).
- No linger after dismissal — one-shot is sufficient; stdout still has the text on scroll-back.
