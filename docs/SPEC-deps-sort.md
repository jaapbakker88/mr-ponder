# Spec: dependency-order sort mode (`deps`)

**Status:** OPEN · **Priority:** P2 · **Drafted:** 2026-09-04
**From:** review of MR 1686 (flat-risk MR, no guidance)
**Depends on:** `SPEC-project-model.md` (profile.importsOf) for full generality;
  ships earlier against hardcoded `node-ts` import detection if needed

## Problem

Risk ordering is designed for "don't miss the dangerous thing." When no risk
signals fire — all files feature-local, no sensitive paths, no shared modules —
the score degenerates to `sizeTiebreak` only, producing an arbitrary order.
A clean feature-add MR presents as an unsorted blob with no guidance on where
to start or how the pieces relate.

`file` mode groups hunks by file but orders files by their riskiest chunk,
which is the same meaningless size tiebreak in the flat-risk case.

Neither mode answers: *what should I read first to understand this change?*

## Design

### New sort mode: `deps`

The `o` key cycles `risk → file → deps` (and wraps). Flash message:
`order: deps (dependency order)`.

Files are ordered by topological depth in the **intra-MR import graph**: the
directed graph whose nodes are the MR's changed files and whose edges are
the import relationships between them. A file imported by others in the MR
comes before the files that import it — read the foundation first.

Within a topological tier, files are ordered by size ascending (smaller first;
fewer distractions before larger consumers). Hunks within a file are top-to-bottom
by line number, same as `file` mode. Sidebar rendering is identical to `file`
mode: bold file-header rows, `├─`/`└─` indented chunk rows.

Test files are always placed last regardless of import relationships (the
`profile.isTest` / `TEST_RE` result, same criterion as `testSink`).

Fallback: if the intra-MR graph has no edges (no import relationships detected
between changed files), fall back silently to `file` mode and flash
`order: deps (no edges found — file order)`.

### Building the intra-MR graph

New module `src/depssort.mjs`:

```js
// Returns a Map<path, Set<path>>: which other MR files does each MR file import?
buildIntraEdges(changedFiles, diffByFile, profile, repoDir)
  -> Map<path, Set<path>>

// Topological sort of file paths. Returns ordered array.
// Test files (per profile.isTest) are appended after the topo order.
// Falls back to input order if edges is empty.
depsOrder(changedFiles, edges, profile) -> string[]
```

**`buildIntraEdges` steps:**

1. For each changed file, obtain its text:
   - File exists on disk (`repoDir` set, file not deleted): `fs.readFileSync`.
   - File is new (op `"added"`) or not on disk: reconstruct from diff added lines
     (strip leading `+`). `diffByFile` is already available in `mrp.mjs`.
2. Call `profile.importsOf(text)` to get the set of import specs this file declares.
3. For each spec, resolve to a repo-relative path via `profile.importSpecOf` inverted:
   check whether any other changed file's `importSpecOf` equals this spec. No full
   spec-to-path resolution is needed — only matching within the changed file set.
4. Each resolved path that is also in `changedFiles` is an intra-MR edge.

The resolution in step 3 is a linear scan over the changed file set (typically
< 50 files). No repo walk, no extra processes.

**Provenance:** edges here are used only for ordering, not risk scoring. The
no-heuristic-in-risk-score rule (`SPEC-project-model.md` §5) does not apply —
a slightly noisy ordering is better than no ordering.

### Relationship to `SPEC-import-graph.md`

When the import graph lands, `buildIntraEdges` is replaced by:

```js
const intra = new Map();
for (const f of changedFiles) {
  const imports = graph.byFile.get(f) ?? new Set();
  intra.set(f, new Set([...imports].filter(s => changedFileSpecs.has(s))));
}
```

No behavior change; the topo sort and display are untouched.

### Relationship to `SPEC-project-model.md`

`profile.importsOf` is the seam. Until that spec lands, `buildIntraEdges`
calls the `node-ts` import extractor directly (the `from '…'` regex already
in `suggest.mjs:23-41`). When the profile is threaded through, swap the call
site; no logic changes.

`generic.importsOf` heuristics are noisier but still produce a useful ordering
for any language — edges that don't resolve to changed files are silently dropped.

## Wire-up

- `src/risk.mjs` `orderChunks`: add `"deps"` mode. Calls `depsOrder`, then
  groups into `fileGroups` same as `"file"` mode.
- `src/ui.mjs` `o` handler: extend cycle array to `["risk", "file", "deps"]`.
  Update flash strings. The `"deps"` mode renders with the same `file`-mode
  sidebar template (no new rendering code needed).
- `mrp.mjs`: pass `diffByFile` into `orderChunks` context (or into a new
  `scoringContext`) so `depsOrder` can reconstruct new-file text from the diff.

## Sequencing

1. `src/depssort.mjs`: `buildIntraEdges` + `depsOrder` + unit tests with a
   fixture changed-file set and known import structure.
2. Wire into `orderChunks` (`risk.mjs`) and `o` cycle (`ui.mjs`).
3. Thread `diffByFile` to the sort call so new-file text is available.
4. After `SPEC-project-model.md` step 4: replace direct `node-ts` call with
   `profile.importsOf`.
5. After `SPEC-import-graph.md` Part A: replace `buildIntraEdges` with the
   graph intersection described above.

## Acceptance

- Fixture MR with files A → B → C (A imports B, B imports C, C is a leaf type):
  `deps` mode shows C first, B second, A third.
- Fixture MR with no import relationships between changed files: `deps` falls
  back to `file` mode, flash message says so.
- Test files always appear after non-test files regardless of import graph position.
- On MR 1686 (`node-ts` repo): `deps` mode produces a meaningful order
  (types/service before routing before UI before mocks).
- On a repo with no `node-ts` profile (pre-`SPEC-project-model.md`): `deps`
  falls back to `file` mode gracefully (no crash, no silent mis-order).
