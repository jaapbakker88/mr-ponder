# Spec: single import-graph pass, branch-accurate scoring

**Status:** OPEN · **Priority:** P1 (refactor first half, then branch accuracy) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §4 · **Depends on:** `SPEC-project-model.md` (profile.importsOf / importSpecOf)

## Problem

Two weaknesses in how fan-out (blast radius) is measured today:

1. **N greps per MR.** `src/risk.mjs:36-53` `fanOut(spec, repoDir)` runs one
   ripgrep per distinct shared spec (`rg -l "from '@/x'" -g *.ts app/src`).
   Fine for one repo's convention; unworkable as the general mechanism once
   profiles supply arbitrary import syntax — you'd need a per-language grep
   pattern anyway, so build the graph once instead.

2. **Scored against the wrong tree.** Fan-out is measured against the local
   checkout, which is usually on `develop` — not the MR branch. A file that
   *became* widely-imported on the branch is systematically under-scored
   (acknowledged parked-P2 in `docs/DECISIONS.md`). Worse, for GitHub PRs in
   repos with no local clone (`MR_REPO_DIR` unset), there is nothing to
   measure against at all.

## Design

### Part A — one graph pass (replaces per-spec greps)

New `src/importgraph.mjs`:

```js
// Walk source roots once, extract each file's imports via the active
// profile, invert into spec -> { importers: [path], provenance }.
buildImportGraph(rootDir, profile, { globs, exclude }) -> {
  bySpec:  Map<spec, { importers: string[], provenance }>,
  byFile:  Map<path, Set<spec>>,        // what each file imports
  failed:  boolean                       // walk itself failed (missing dir, …)
}
fanOutFor(graph, spec) -> { count, files, failed }
```

- Walk with `rg --files` (already a hard dependency of `fanOut` today) or
  `fs.readdir` recursive — `rg --files` is faster and respects ignore files;
  keep it. One process for the whole walk vs N.
- `provenance: "profile"` when the edge came from the profile's `importsOf`
  (a real import statement in a real file); `"heuristic"` when it came from
  `generic`'s loose patterns. Risk scoring counts only `"profile"` edges
  (`SPEC-project-model.md` §5).
- `fanOutFor(graph, spec)` replaces `fanOut(spec, repoDir)` in
  `src/risk.mjs`: same return shape (`{ count, files, failed }`) so the
  scoring/unknown logic (lines 86-96) is untouched. `failed` now means "the
  walk failed or the spec resolves nowhere measurable" — the fail-loud +75
  nudge survives verbatim.
- `suggest.mjs` `buildImportEdges` switches to `graph.byFile`/`bySpec` for its
  producer/consumer edges (instead of re-reading files); its diff-window
  fallback (`suggest.mjs:36-38`) stays for files not on disk.

Behavior on the current TS repo must be **identical** (the same importer sets,
same counts) — this is a refactor, verified by keeping
`tests/risk.test.mjs` green plus a new fixture test comparing graph output to
the old grep output on a temp repo.

### Part B — score against the MR head ref

The forges expose a fetchable ref for the MR head without touching the working
tree:

- GitLab: `refs/merge-requests/<iid>/head`
- GitHub: `refs/pull/<n>/head`

Steps:

1. **Fetch, don't checkout.** In `mrp.mjs`, before scoring:
   `git fetch --depth=1 origin refs/merge-requests/<iid>/head` (cwd `repoDir`),
   capturing the FETCH_HEAD sha. Failures are **non-fatal and loud**: print
   `mrp: could not fetch MR ref — scoring against local checkout` and fall
   back to Part A behavior (local tree). A TUI review tool must never die
   because a ref fetch hiccuped; it must also never *silently* score the wrong
   tree — hence the notice. (No local clone at all → skip to the diff-window
   fallback, same as today.)
2. **Read blobs, not the working tree.** New helper in `src/importgraph.mjs`:
   read file contents at a sha via `git cat-file --batch` (one process, feed
   all wanted paths, read blobs back). For files **changed in the MR**, read
   content from the fetched ref (branch-accurate); for all other files (the
   importers — the bulk of the walk), the local checkout is fine because
   unchanged files are identical on both refs.
   Changed-file list comes from the already-fetched `changes` array
   (`mrp.mjs:133-135` builds `diffByFile` — same source).
3. **Overlay rule.** `buildImportGraph(rootDir, profile, { overlay: Map<path,
   blobText> })` — when a path is in the overlay, extract imports from the
   blob text instead of disk. Pure function over text either way, so the
   module stays unit-testable with fixtures.
4. **UX honesty.** Header/flash notes the scoring source:
   `fan-out: branch-accurate (fetched <short-sha>)` vs
   `fan-out: local checkout (fetch failed)` vs `fan-out: diff-window only`.

Why `cat-file` and not a temp checkout: `--depth=1` + blob reads cost one fetch
(~the size of the MR) and zero disk churn; a checkout would touch the user's
working tree or require a second clone.

## Edge cases

- **Squash-merge workflows / rebased MRs:** head ref still exists per-MR; fine.
- **Huge monorepos:** `--depth=1` limits history; the walk is one `rg --files`
   + batched blob reads — comparable to today's N greps. If it proves slow,
   cache the graph per (repo, ref-sha) in `~/.cache/mrp/` — noted as an option,
   not v1.
- **Shallow-detached local checkout at an unrelated sha:** fetch succeeds
   (remote ref), overlay covers changed files — correct.
- **`git` security (`insteadOf` rewrites, SSH auth)**: fetch uses the same
   remote/auth the user's normal `git push` uses; no new credential path.
- **Binary/generated files in the walk:** `importsOf` on garbage returns an
   empty set (regexes simply won't match) — no crash, no edges.

## Out of scope

- Caching fetched refs between runs (re-fetch each start; cheap with
  `--depth=1`).
- Cross-repo edges (importing another repo's package) — spec resolution stays
  within this repo, as today.

## Sequencing

1. `src/importgraph.mjs` Part A + tests (temp-dir fixture repo, like
   `tests/risk.test.mjs`); re-point `risk.mjs` `fanOut` → `fanOutFor`; verify
   identical scores on the real repo.
2. `suggest.mjs` `buildImportEdges` onto the graph; diff-window fallback kept.
3. Part B: fetch helper in `mrp.mjs` + `cat-file --batch` blob reader +
   `overlay` support; fallback notice; header source display.
4. Tests for Part B with a local fixture git repo (init, commit, branch,
   fetch-ref flow — all local, no network in CI).

## Acceptance

- On the current TS repo: identical risk order before/after Part A
  (characterization test).
- A fixture MR where a file's importers only exist on the MR branch: after
  Part B that file's fan-out reflects the branch, not `develop`.
- No local clone + GitHub PR: runs, warns `diff-window only`, never crashes.
- Fetch failure on a real repo: prints the fallback notice, scores against
  local checkout.
