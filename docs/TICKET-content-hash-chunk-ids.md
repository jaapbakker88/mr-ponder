# Ticket: content-hash chunk ids — catch in-place content changes on force-push

Type: feature · Status: **done** · **Priority:** P1 · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §7

## Resolution

Shipped 2026-09-03. See implementation notes in `docs/DECISIONS.md`.

### Changes

- `src/diff.mjs` — `fnv1a(str)` (FNV-1a 32-bit, exported for tests); `hashBody(lines)`
  (normalises CRLF→LF before hashing); every chunk gains `contentHash`.

- `src/store.mjs` — `reconcile` 4th param changed from `string[]` to
  `{ id, contentHash }[]`. Persists `reviewedChunks: { [id]: hash }` alongside
  legacy `reviewedChunkIds`. Delta logic: id absent → new; id present + hash
  differs → new **and** orphaned. Returns `changedCount` for display.
  Migration: old state (reviewedChunkIds only) uses id-only comparison on first run,
  then upgrades automatically.

- `mrp.mjs` — stale-SHA notice now reports "N rewritten, M added/removed".

- `tests/store.test.mjs` — existing tests migrated to `{ id, contentHash }` shape;
  8 new tests covering same-hash (not new), different-hash (new + changedCount +
  orphaned), legacy migration, first-review edge case.

- `tests/diff.test.mjs` — 7 new tests: fnv1a stability, contentHash on real and
  synthetic chunks, CRLF normalisation.

- `docs/DECISIONS.md` — implementation note added.
