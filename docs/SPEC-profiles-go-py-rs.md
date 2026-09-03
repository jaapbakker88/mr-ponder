# Spec: go, python, rust profiles

**Status:** OPEN · **Priority:** P2 (after the seam proves out) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §3 · **Depends on:** `SPEC-project-model.md` (profile interface), `SPEC-import-graph.md` (graph)

## Problem

With the project-model seam in place, the three highest-value real profiles are
missing. Each is a small rule table — pure functions over path/text, testable
with fixture strings, no parsers.

## Design

### `src/profiles/go.mjs`

- **Detection input:** `go.mod` (already wired in `SPEC-project-model.md`).
- `isTest`: `/^(.*\/)?[^/]+_test\.go$/` — Go's convention is uniform and
  compiler-enforced (a `_test.go` file can only be compiled into the test
  binary). The surest test regex of any language.
- `isShared(path, fanOut)`: Go has no "shared dir" convention — reach IS the
  signal. `fanOut == null ? null : fanOut >= 2` (one importer is normal usage;
  2+ is a shared package). Same measured-reach philosophy as `generic`, with a
  tighter threshold because Go import edges are always real (compiler-checked).
- `importSpecOf(path)`: the importable unit is the **directory** (package), not
  the file. Resolve `module` from `go.mod`, strip it as a prefix:
  `internal/auth` → `github.com/org/repo/internal/auth`. The graph keys on this
  spec; fan-out counts files importing the package path.
- `importsOf(text)`: match both forms —
  `import "github.com/org/repo/pkg/x"` and grouped
  ```
  import (
    "fmt"
    "github.com/org/repo/pkg/x"
  )
  ```
  Strip module prefix from results so intra-repo edges use bare package paths
  (`internal/auth`), matching what `importSpecOf` produces.
- `exportedSymbols(text)`: lines matching
  `/^(func|type|const|var)\s+([A-Z]\w*)/` (capitalized = exported — again
  compiler-enforced). The best `*`-extraction signal of any language.

### `src/profiles/python.mjs`

- **Detection input:** `pyproject.toml` | `setup.py` | `setup.cfg`.
- `isTest`: `/^(.*\/)?test_[^.]+\.py$/` or `/^(.*\/)?[^/]+_test\.py$/` or path
  contains `/tests?/` (project-relative prefix only, to avoid sinking
  `tests/`-named source dirs in odd layouts — over-match is still safe since
  tests sink).
- `isShared(path, fanOut)`: no uniform convention — measured reach:
  `fanOut == null ? null : fanOut >= 3` (same as generic; Python's dynamic
  imports justify the looser bar).
- `importSpecOf(path)`: package name from `pyproject.toml`/`setup.cfg`
  (`[project] name` / `name =`), else fall back to repo-relative path with
  `/`→`.` and `__init__.py` → directory (a package's importable name is its
  dir). Config file is read once at profile construction, passed in — profiles
  stay pure over text after that.
- `importsOf(text)`: `from X.Y import …` (capture `X.Y`), `import X.Y`
  (capture `X.Y`), and relative `from .mod import …` / `from ..pkg.mod import …`
  → resolve against the importing file's path (needs the path passed alongside
  text — the profile interface already carries it via `importSpecOf` of
  siblings; extend `importsOf(text, selfPath)`).
- **Unknown semantics (important):** dynamic imports (`importlib.import_module`,
  `__import__`, plugin registries) are invisible to static extraction. They
  simply produce no edges — so affected files sit at measured fan-out from
  their static imports, and anything with no static edges stays `unknown` when
  the walk couldn't assess it. This is the correct, honest behavior; document
  it in the profile header, don't fight it.
- `exportedSymbols(text)`: top-level (unindented) `def name(` / `class Name` —
  leading-underscore names filtered.

### `src/profiles/rust.mjs`

- **Detection input:** `Cargo.toml`.
- `isTest`: Rust tests live in the same file (`#[test]`) — path-based test
  detection is impossible. `isTest: () => false`, and note it: the `e` test
  filter and the test-sink bias simply have no Rust equivalent; `tests/`
  integration-test dirs still match via `/tests?/` path segment → fold that
  one path check in, sink only integration tests.
- `isShared(path, fanOut)`: measured reach, `fanOut >= 2` (intra-repo `use`
  edges are compiler-checked like Go).
- `importSpecOf(path)`: module path from repo-relative path, `/`→`::`,
  `mod.rs`/`main.rs`/`lib.rs` → parent (a module's importable name is its
  module tree position).
- `importsOf(text)`: `use crate::mod::x` (intra-repo — capture `crate::…`
  prefix trimmed to the module path); `use super::`/`use self::` resolve
  against the importing file's path; `pub use` re-exports count as imports of
  the source module. External crates (`use serde…`) are out of scope
  (cross-repo, excluded everywhere already).
- `exportedSymbols(text)`: `/^(pub\s+)?(fn|struct|enum|trait|type|const)\s+(\w+)/`
  — `pub` items are the exported surface; non-pub included as candidates for
  same-file cross-hunk threads (the `*` panel's purpose), ranked below pub.

## Shared structure

All three are pure modules in the same shape as `src/profiles/node-ts.mjs`;
each gets a test file of fixture strings (imports snippets per language,
including the grouped-Go and relative-Python cases above). Register each in
`src/profile.mjs`'s detect table per `SPEC-project-model.md`.

## Edge cases

- Go: `internal/` packages can only be imported within the module — irrelevant
  to counting (we count within the repo anyway).
- Python relative imports crossing the changed file's package (`..` past root)
  → drop the edge, don't guess.
- Rust `#[cfg(test)]` modules inside src files: not tests for our purpose —
  they're production-file changes; the sink bias shouldn't apply. (Deliberate;
  the `e` filter covers explicit test browsing.)
- Workspaces (`Cargo.toml` with `[workspace] members`): detection still fires;
  intra-repo `use crate::` is per-crate — `importSpecOf` should key on the
  member crate root it belongs to. Keep v1 simple: treat the whole workspace
  as one tree, note the imprecision in the profile header.

## Out of scope

- Java/Kotlin, Ruby/Rails, PHP profiles — same recipe, add when needed.
- Tree-sitter-based extraction (see `docs/IDEAS.md` §8).

## Sequencing

1. `go.mjs` + `tests/profile-go.test.mjs` (fixtures: grouped/inline imports,
   module-prefix strip, `_test.go` sink, capitalized exports).
2. `python.mjs` + tests (relative-import resolution, package-name fallback,
   `__init__.py` handling, top-level def/class).
3. `rust.mjs` + tests (`crate::`/`super::` resolution, mod.rs collapsing,
   pub-symbols, `tests/` integration dirs).
4. Register all three in detect; end-to-end sanity: `--profile go` on a
   Go-repo MR shows real fan-out and sunk tests.

## Acceptance

- Per profile: the fixture test table passes (imports, specs, tests, exports).
- On a real Go repo MR: test files sink, `pkg/auth` sorts by sensitivity first
  then real measured fan-out, `*` offers capitalized Go symbols.
- On a real Python repo MR: same story with package paths; dynamic-import-only
  files show `unknown`, not fake zero.
- On a real Rust repo MR: `crate::` edges form real import links; src-file
  `#[cfg(test)]` chunks do NOT sink.
