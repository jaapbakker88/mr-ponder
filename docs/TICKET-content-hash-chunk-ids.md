# Ticket: content-hash chunk ids — catch in-place content changes on force-push

Type: feature · Status: open · **Priority:** P1 (self-acknowledged gap in `docs/DECISIONS.md`) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §7

## Problem

Chunk identity is `file@oldStart:newStart` (`src/diff.mjs`, consumed by
`src/store.mjs:64-91` reconcile). The delta detection (`newIds`) and orphan
detection both key on this id alone. Two failure modes:

1. A force-push **rewrites a hunk's content** but the `@@` start lines happen
   to hold → the id is unchanged → the chunk is NOT flagged `[new]`, and
   previously-made annotations silently attach to *different* content.
2. Conversely the "annotations may point at shifted lines" warning fires on
   every force-push even when the hunks are actually untouched — noisy.

DECISIONS.md already calls this out: "delta-by-chunk-identity, not a true
diff-of-diffs."

## Proposed fix (small)

Store a cheap **content hash** of the hunk body alongside the id:

1. `src/diff.mjs`: when building a chunk, compute
   `hash = fnv1a(bodyLines.join("\n"))` — pure, dependency-free, 20 lines of
   code (FNV-1a 32-bit is fine for change detection, not security).
   Chunk shape gains `contentHash`.
2. `src/store.mjs` `reconcile`: persist `reviewedChunks: { id: contentHash }`
   (new field; keep `reviewedChunkIds` for one migration release, then drop).
   Delta logic becomes: id not in previous set ⇒ `new`; id present but hash
   differs ⇒ `new` **and** the old id goes into `orphaned` (annotations made
   against different content must not silently re-attach — same principle as
   the head-SHA guard, now at hunk granularity).
3. `src/ui.mjs`: `[new]` badge and `d` filter work unchanged — they read
   `isNew`, which now means "new or content-changed."
4. The stale-SHA notice (`mrp.mjs:165-172`) can now say how many chunks
   actually changed vs. merely shifted.

## Edge cases

- Line-ending changes (CRLF↔LF) would flip the hash: normalize `\r\n`→`\n`
  before hashing.
- Whitespace-only rewrites: hash changes, chunk flags `[new]` — correct
  (whitespace rewrites *are* force-push deltas), though arguably low value;
  accept (do not "smart"-normalize indentation — that's guessing).
- Old state files without `reviewedChunks`: treat as first-review-of-record
  (delta empty), same as today's `reviewedChunkIds: null` path.

## Steps

1. `fnv1a` helper + `contentHash` in `diff.mjs` (unit: same body ⇒ same hash,
   one-char change ⇒ different).
2. `store.mjs` `reconcile` dual-field logic + tests (unchanged content ⇒ not
   new; changed content ⇒ new + orphaned; id-absent ⇒ new).
3. `mrp.mjs` notice counts.
4. Migration note in `docs/DECISIONS.md` implementation-note style.

## Acceptance

Simulate a force-push in tests: same file, same `@@` positions, one changed
line in the body ⇒ chunk flagged `[new]`, prior annotations on that id listed
as orphaned. Unchanged hunks in the same push ⇒ not flagged, annotations kept.
