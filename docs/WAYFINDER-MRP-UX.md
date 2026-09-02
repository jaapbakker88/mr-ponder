# Wayfinder Map: mr-ponder UX improvements

## Destination

Two features to ship in mr-ponder:
1. ✅ **SHIPPED** The stale-SHA warning ("MR updated since last review…") is visible *inside* the TUI session, not just printed to stdout before Ink takes over.
2. `n`/`N` search navigation jumps to individual match *instances* (chunk + line) rather than just next matching chunk/file; a persistent search status indicator shows the current pattern, file, and instance counts.

## Notes

Backing: markdown files in `mr-ponder/docs/`. Skills: grilling, domain-modeling.
Code lives in `src/ui.mjs` (TUI) and `mrp.mjs` (bootstrap/pre-Ink warning).
Key facts from exploration:
- Stale-SHA warning is printed to raw stdout at `mrp.mjs:131–138` before Ink starts. Data (`staleSha`, `orphaned.length`, `newIds.length`) already computed there.
- `visible` is a chunk-level filtered array; `n`/`N` steps chunk indices (`src/ui.mjs:718–730`). No per-line match index exists.
- Footer (`src/ui.mjs:1121–1144`) is the only status bar. Flash system: 1.5s auto-clear.
- Header bar at line 1149 has spare space on the right side.

## Decisions so far

- [Stale-SHA warning — display design](TICKET-grilling-stale-sha-display.md): Option C — `⚠ +N ~M` badge in header right side; `!` opens full-text overlay; closing overlay or pressing `d` removes badge (one-shot). **Implemented** (`src/ui.mjs:247–248, 276, 834, 1184`).

## Out of scope

- Persisting or re-fetching the stale-SHA state mid-session (MR could be updated again while mrp is open).
- Replacing the pre-Ink stdout warning (keep it; it's useful in non-TTY / pipe contexts).
