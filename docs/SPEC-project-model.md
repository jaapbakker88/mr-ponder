# Spec: project model — language-agnostic risk scoring

**Status:** OPEN · **Priority:** P0 (prerequisite for all language work) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §2 · **Blocks:** go/python profiles, `SPEC-import-graph.md` step 3+, `SPEC-deps-sort.md` step 4

## Problem

The "what counts as shared / how do imports look / what's a test" rules are
hardcoded for one repo shape (TS/React, `app/src/…`, `@/` aliases) and smeared
across four modules:

| Location | Assumption |
| --- | --- |
| `src/paths.mjs:8-9` `SHARED_RE` | shared = top-level dir under `app/src/{components,hooks,…}` |
| `src/paths.mjs:11` `TEST_RE` | tests = `*.test/spec.{t,j}sx?` only |
| `src/paths.mjs:14-18` `importSpec` | every file maps to a `@/…` specifier |
| `src/risk.mjs:42` `fanOut` | greps `-g *.ts -g *.tsx` under literal `app/src` |
| `src/suggest.mjs:28` `fileImports` | imports matched via `from '@/…'` regex |
| `src/ui.mjs` (`*` handler) | exports = `export const/function/class/type…` |

On any other stack (Go, Python, Rust, even a different TS layout): fan-out is
dead, everything shared reads as `unknown` (uniform +75 → the fail-loud signal
flattens to noise), tests float as production code, and import edges + `*`
extraction are inert. The GitHub adapter makes this bite on every foreign repo.

## Design

### 1. One seam: a profile object

New module `src/profile.mjs` exporting the interface and the registry:

```js
// A profile answers per-file questions for one ecosystem. All functions are
// PURE (text/path in, answer out) so they unit-test with fixture strings.
Profile = {
  name,                                  // "node-ts" | "generic" | "go" | …
  isTest(path) -> bool,
  isShared(path, fanOut) -> bool | null, // null = can't assess → unknown
  importSpecOf(path) -> spec | null,     // module name others import
  importsOf(fileText) -> Set<spec>,      // what THIS file imports
  exportedSymbols(fileText) -> [string], // candidates for `*` thread-following
}
```

`detect(rootFiles, packageJson?)` in the same module sniffs the repo root:

- `go.mod` → `go` · `pyproject.toml`|`setup.py`|`setup.cfg` → `python` ·
  `Cargo.toml` → `rust` · `Gemfile` → `ruby` · `composer.json` → `php` ·
  `pom.xml`|`build.gradle*` → `java` · `package.json` → `node-ts` (later
  refined by `tsconfig.json` `compilerOptions.paths` for the real alias, with
  the current `@/` as fallback)
- nothing matches → `generic`

Detection is **displayed, never silent**: the TUI header flash on startup says
`profile: go (detected)` / `profile: generic (fallback)`. Overridable via
`--profile <name>` flag and `MRP_PROFILE` env (flag > env > detect).

### 2. Extract `node-ts` verbatim (regression-proof reference)

New `src/profiles/node-ts.mjs` containing today's logic moved, not rewritten:

- `isTest` = `TEST_RE` (`paths.mjs:11`) unchanged
- `isShared` = `SHARED_RE` test (`paths.mjs:8-9`), **plus** `fanOut != null`
  (measured reach may promote a file the dir proxy misses — see generic, §3)
- `importSpecOf` = `importSpec` (`paths.mjs:14-18`) unchanged
- `importsOf` = the `from '…'` regex from `suggest.mjs:23-41`, lifted so
  `suggest.mjs` and the graph builder share ONE extractor
- `exportedSymbols` = the `export …` extraction currently inline in `ui.mjs`'s
  `*` handler, lifted unchanged

`src/paths.mjs` stays as-is (it is re-exported by `risk.mjs:15` and imported by
tests); it simply becomes an implementation detail of the profile. No behavior
change — `node --test` must pass unmodified.

### 3. `generic` fallback profile — the "never lie" floor

New `src/profiles/generic.mjs`:

- `isTest`: union of common conventions —
  `/(^|\/)(tests?|__tests__|spec)(\/|$)/i`, `/[._-](test|spec)\.[^.]+$/`,
  `/^test_[^.]+$|_test\.[^.]+$/` (covers `test_*.py`, `*_test.go`, `FooTest.java`
  via `_test`/`Test`… keep `Test` suffix out — too many false positives like
  `Latest.tsx`; `FooTest.java` is sunk later by the java profile). Slight
  over-matching is safe (tests sink).
- `isShared`: **derived from the measured import graph** — `(path, fanOut) =>
  fanOut == null ? null : fanOut >= 3`. This replaces the directory-name proxy
  with the thing the proxy approximated. No graph → `null` → `unknown` nudge
  (sorts up — correct, honest).
- `importSpecOf`: `null` (no alias convention is guessable) — EXCEPT path
  identity: fall back to the repo-relative path itself as spec, so a
  plain-relative import (`./utils.js`, `from . import x`) can still match.
- `importsOf`: language-agnostic "looks like an import" heuristics
  (`import …`, `from … import`, `require(`, `use …`, `#include`, `@import`).
  Noisy by design — **heuristic edges feed link suggestions only, never the
  risk score** (see step 5).
- `exportedSymbols`: `[]` (heuristic export detection is junk; `*` degrades to
  the `@@` context-line signal, which is language-neutral).

### 4. Thread the profile through the pipeline

Callers change from module-level regex calls to the profile instance:

1. `mrp.mjs`: after `repoDir` resolution (~line 79), run `detect` (root file
   list via `fs.readdirSync(repoDir)`; when `repoDir` is null, detect against
   the *changed files* in the MR as a weak signal, else `generic`). Pass
   `profile` into `scoreChunks` and `buildImportEdges`.
2. `src/risk.mjs:61` — `scoreChunks(chunks, { repoDir, profile })` (second
   param becomes a context object; `profile` defaults to `node-ts` so existing
   tests keep passing). `scoreChunks` uses `profile.isTest/isShared/
   importSpecOf` instead of `SHARED_RE/TEST_RE/importSpec` imports.
3. `src/risk.mjs:36-53` `fanOut` — the `rg -g *.ts -g *.tsx app/src` call is
   replaced by a graph lookup (see `SPEC-import-graph.md`; until that lands,
   keep the grep but take the glob list + search root from the profile:
   `node-ts` = `['*.ts','*.tsx']` + `app/src`; `generic` = no globs, repo
   root).
4. `src/suggest.mjs:46` — `buildImportEdges(chunks, { repoDir, profile,
   diffByFile })`; `fileImports` calls `profile.importsOf` on file text.
5. `src/ui.mjs` `*` handler — candidate extraction calls
   `profile.exportedSymbols` (plus the existing `@@` context signal, which
   stays as signal #1 for every profile).

### 5. Provenance: heuristic answers must not feed risk

The graph (from `SPEC-import-graph.md`) tags each edge
`{ spec, importer, provenance: "profile" | "heuristic" }`. `scoreChunks` counts
only `"profile"` edges toward fan-out; `suggestLinks` accepts both (a human
judges suggestions; the risk score must not lie). This is the mechanism that
makes `generic` safe.

## Edge cases

- **Monorepo with mixed ecosystems** (e.g. `package.json` + `Cargo.toml`):
  detection is ambiguous → `generic` + a stderr hint listing the markers seen.
  Per-directory profiles are explicitly out of scope (v1).
- **`repoDir` null (no local clone):** detection falls back to the MR's changed
  paths; fan-out has nothing to grep → every shared candidate is `unknown`
  (sorts up). Same as today's behavior, now honestly labeled.
- **State/annotations:** none of this touches `store.mjs` — profiles only
  affect scoring and suggestions, which are recomputed per run.
- **`mrs` compatibility:** `mrs` imports nothing from `mrp` today; nothing to
  break. The eventual shared-model move (parked P2) starts from this seam.

## Out of scope

- `go`/`python`/`rust` profile *contents* — separate specs once the seam lands.
- Import-graph builder — `SPEC-import-graph.md`.
- Tree-sitter — deferred (see `docs/IDEAS.md` §8).
- Dependency-order sort — `SPEC-deps-sort.md` (uses `profile.importsOf`; ships
  against the hardcoded `node-ts` extractor until this spec's step 4 lands).

## Sequencing

1. Create `src/profiles/node-ts.mjs` by moving (not rewriting) the five
   functions; re-point `paths.mjs` consumers; `npm test` green, zero behavior
   change.
2. Add `src/profile.mjs` (interface + detect + registry) with tests for
   detection over fixture root file lists.
3. Add `src/profiles/generic.mjs` + tests (isTest table, isShared threshold
   logic with null propagation).
4. Thread context-object through `scoreChunks` / `buildImportEdges` / `ui.mjs`
   `*`; `mrp.mjs` detection + `--profile`/`MRP_PROFILE` + startup flash.
5. Update root README ("works on any repo; profiles; generic floor") and the
   `Known gaps` section.

## Acceptance

- `node --test` passes unchanged after step 1 (byte-for-byte extraction proof).
- Fixture MR with Go-style paths (`pkg/auth/verify.go`, `pkg/auth/verify_test.go`):
  under `generic`, the test file sinks, the auth path gets its sensitivity
  weight, and the non-test file shows `unknown` (not fake fan-out).
- `mrp <iid>` on a repo with `go.mod` prints `profile: go (detected)` — or with
  no markers, `profile: generic (fallback)` — and `--profile node-ts` overrides.
