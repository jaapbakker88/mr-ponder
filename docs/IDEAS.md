# Ideas — making the risk model language- and layout-agnostic

> Status: **documented only, nothing implemented.** Working notes for future work.
> Spawned from a discovery pass (2026-09-02) after the GitHub adapter landed: the
> risk model is built on one repo's conventions (TS/React, `app/src/…`, `@/`
> aliases) and silently degrades on anything else — which matters more now that
> `mrp` can open GitHub PRs from arbitrary repos.

## 1. Problem: where the TS/React assumptions live

The conventions aren't in one place — they're smeared across four modules:

| Module | Hardcoded assumption | Effect on other stacks |
| --- | --- | --- |
| `paths.mjs` `SHARED_RE` | "shared" = top-level dir under `app/src/{components,hooks,services,lib,utils,providers,layouts,constants,types}` | No `app/src` → nothing is ever shared → fan-out signal disabled entirely |
| `paths.mjs` `importSpec` | files map to `@/…` TS-style import specifiers | `null` for every non-matching path |
| `paths.mjs` `TEST_RE` | tests = `*.test/spec.{ts,js,tsx,jsx}` | Go (`*_test.go`), Python (`test_*.py`), Rust (`*_test.rs`) tests are NOT sunk — they score as production code |
| `risk.mjs` `fanOut` | greps `-g *.ts -g *.tsx` under a literal `app/src` dir for `from '…'` | grep always fails → every shared file becomes `unknown` → uniform +75 nudge → the unknown signal flattens to noise |
| `suggest.mjs` `fileImports` | imports matched via `from '@/…'` regex | zero import edges → link suggestions degrade to same-file/same-tag only |
| `ui.mjs` `*` identifier extraction | `export const/function/class/type…` declarations | Go (capitalized = exported), Python, Rust (`pub`) symbols invisible to thread-following |
| `sensitivity.mjs` defaults | mostly path-based, but tuned to this org's folder vocabulary | decent, but misses Rails/Django/Go-style migration dirs, etc. |

Net effect on a Go/Python/Rust/Java repo: sensitivity still works (pure path
regex), but fan-out is dead, everything shared reads as `unknown`, tests float
to the top as if they were production code, and half the tool's connective
tissue (import edges, `*`, importers panel) is inert. The fail-loud design
becomes fail-always-loud, which is fail-quiet in disguise.

## 2. Core proposal: a `ProjectModel` abstraction

Introduce one seam — a per-language "project model" — that everything else
consumes:

```
ProjectModel:
  detect(root) -> profile | null          // ecosystem sniffing
  isTest(path) -> bool
  isShared(path) -> bool | null           // null = can't assess (fail-loud)
  importSpecOf(path) -> spec | null       // the module "name" others import
  importsOf(fileText) -> Set<spec>        // what THIS file imports
  exportedSymbols(fileText) -> [symbol]   // for `*` thread-following
  buildImportGraph(root, overrides) -> Graph  // spec -> importing files
```

`risk.mjs`, `suggest.mjs`, and the `*` extraction all switch to this interface.
The current behavior becomes the `node-ts` profile, byte-for-byte.

**Profiles to ship, in order of value:**
1. `node-ts` — today's behavior, extracted verbatim (regression-proof reference).
2. `generic` — the universal fallback (see §5). Ships first; guarantees the tool
   never degrades worse than "sensitivity + same-file links" on any repo.
3. `go`, `python`, `rust` — the highest-value real profiles (small rule tables,
   see §3).
4. `java`/`kotlin`, `ruby` (Rails has strong conventions), `php` — later, on demand.

**Detection** = cheap marker sniffing at the repo root: `package.json` (then
`tsconfig.json` paths for the alias), `go.mod`, `pyproject.toml`/`setup.py`,
`Cargo.toml`, `Gemfile`, `composer.json`, `pom.xml`/`build.gradle`. Ambiguous
(monorepos) → prompt or fall back to `generic`. Detection result should be
*displayed* ("using profile: go (detected)") and overridable with a flag, never
silent.

## 3. Import extraction: a per-language pattern table, not regex-in-code

The minimum viable version is data, not parsers — a table of
`import-statement patterns` per language:

- **Go**: `import "github.com/org/repo/pkg/x"` + grouped `import ( … )`; module
  prefix from `go.mod`; test files import via same syntax. Fan-out = who imports
  the package path.
- **Python**: `from pkg.mod import x` / `import pkg.mod`; relative `from .mod`;
  package name from `pyproject.toml`. (Dynamic imports are out of scope — they
  become "unknown", which is correct behavior.)
- **Rust**: `use crate::mod::x`; `pub` for exports. Paths-based, no crate-graph
  needed for intra-repo edges.
- **Java/Kotlin**: `import com.org.repo.pkg.Clazz;` — the package convention is
  nearly uniform, extraction is trivial even though the ecosystem isn't.

Keep the extraction as **per-language modules with pure functions over file
text** (same shape as `paths.mjs` today), so they stay unit-testable with
fixture strings and no repo/IO. A regex table is the v1; tree-sitter (§8) is the
v2 if regexes prove too brittle in practice.

## 4. Fan-out: build one import graph per run, not N greps

Today `fanOut` runs one ripgrep per shared spec against the working tree. Two
upgrades, independent of the language work:

1. **Single graph pass.** Walk the source roots once, extract imports per file
   (via `ProjectModel.importsOf`), invert into `spec → [importing files]`.
   Fan-out = reverse-edge count. This is one pass instead of N greps, gives the
   *same* answer for any language, and produces the importer lists (the `i`
   panel) for free.
2. **Score against the MR branch, not local `develop`.** Both forges expose a
   fetchable MR head ref — GitLab `refs/merge-requests/<iid>/head`, GitHub
   `refs/pull/<n>/head`. A `git fetch --depth=1` of that ref plus
   `git cat-file --batch` lets us read branch-accurate file contents **without
   touching the user's working tree** (no checkout, no stashing). Overlay rule:
   for files changed in the MR, read blob content from the fetched ref; for the
   rest, the local checkout is fine. This closes the parked P2 gap
   ("newly-shared files under-scored") *and* makes the local checkout optional
   for GitHub-only repos with no clone at all.

   Unknown/fail-loud semantics are preserved: a file we can't read (binary,
   generated, dynamic imports) contributes `unknown`, which sorts up.

## 5. The `generic` fallback profile — the "never lie" floor

When no ecosystem matches (or detection is ambiguous), `mrp` must not pretend.
The `generic` profile:

- `isTest`: union of common test patterns (`test`, `tests/`, `spec`, `*_test.*`,
  `test_*.*`, `__tests__`) — over-matching slightly is safe (tests sink).
- `isShared`: **derived from the import graph itself** — a module whose measured
  fan-out exceeds a threshold *is* shared, regardless of directory name. This
  replaces the `SHARED_RE` proxy with the thing the proxy was approximating.
- `importsOf`: language-agnostic "looks like an import" heuristics
  (`from … import`, `import `, `use `, `#include`, `require(`, `@import`) —
  noisy by design, so edges from heuristics only feed *link suggestions*
  (low-stakes, human-judged) and never the risk score.
- Risk contribution: sensitivity (path regex — works anywhere) + size + unknown
  nudges. Fan-out contributes only when the graph found real edges.

The floor guarantees: sensitivity ordering and fail-loud unknowns survive on
*any* repo, tests still sink, and the tool says "profile: generic (detected)"
instead of silently mis-scoring. Honesty about capability beats confident
wrongness — same principle as the existing unknown semantics.

## 6. Per-language sensitivity rule packs

`sensitivity.mjs` is already data-driven; finish the job with per-profile
**default rule packs** layered under user config:

- Rails/Django/Alembic/Flyway migration dirs (`db/migrate/`, `migrations/`,
  `alembic/versions/`) — some already match, verify per-framework.
- Go: `auth/`, `middleware/`, `cmd/` entry points.
- Infra already covers `.tf`/helm/k8s — add `Procfile`, `Makefile` targets?  (No
  — Makefile is too noisy. Leave out, note why: `Makefile` changes are usually
  trivial-print/phony; weight would cry wolf.)
- Add a **content-signal** class of rules (matched against *added lines* in the
  hunk, not just paths): `DROP TABLE`, `ON DELETE CASCADE`, `TRUNCATE`,
  `sudo `, `eval(`, `innerHTML`, `--no-sandbox`, `ALLOW_HOSTS`. Path rules say
  *where* consequence lives; content rules catch destructive operations hiding
  in bland paths. Cheap, language-agnostic, and the natural complement to the
  existing threat model. (Careful with false-positive budget — start
  conservative, ~3–5 rules, tune via the export loop.)

## 7. Fixes to the existing model worth doing regardless of language work

- **Content-aware delta detection.** Today's `newIds` is chunk-identity
  (`file@oldStart:newStart`); a hunk whose content changed but start lines held
  isn't flagged. Store a cheap content hash (e.g. FNV/xxhash of the hunk body)
  alongside the id in `store.mjs`; on reconcile, mismatched hash ⇒ treat as new
  (and orphan the old annotations, since they may now be stale). Self-acknowledged
  gap in DECISIONS.md; small, self-contained, high value for the force-push loop.
- **`docs/README.md` is a stale duplicate** of the root README — delete or make
  it a docs index (it currently re-lists specs/tickets by hand).
- **No CI.** Add a GitHub Actions workflow: `node >= 20`, `npm ci`, `npm test`.
  The repo is public now; PRs deserve the same test gate the local run gives.
- **Sensitivity calibration loop.** DECISIONS.md names reviewer-note density as
  the tuning signal and the export already emits notes+labels. A future
  `mrp tune` could aggregate exports across reviewed MRs and suggest weight
  adjustments ("notes on `money` paths: 4× average density — consider 500→550").
  Pure offline analysis, no new state.
- **Test-sink is all-or-nothing (-1000).** A 3-line change to a test for a
  sensitive module vs a 500-line rewrite of assertions are equally sunk. Soften
  to a multiplicative dampener (e.g. cap at sensitivity, not −1000 flat) so
  *large* test changes still surface. Or keep it and document why: reviewers
  never need test-first ordering. Decide during the profile work, since test
  patterns change anyway.

## 8. Explicitly deferred / rejected

- **Tree-sitter parsers for import/export extraction.** The right long-term
  answer for robustness (one grammar per language replaces all regexes, and
  gives `*` identifier extraction for free), but it adds a native-dependency
  payload that clashes with the zero-build, plain-`.mjs` ethos. Revisit when ≥3
  regex profiles exist and their brittleness is *demonstrated*, not anticipated.
- **LSP / language servers.** Rejected for now: process management, per-repo
  startup cost, and a failure mode (server won't start) that breaks the walk.
  The fetch-the-MR-ref approach (§4) gets branch-accurate data without any
  server.
- **Full static analysis / type-level blast radius.** Out of scope — `mrp` ranks
  reviewer attention, it doesn't verify correctness. The DECISIONS.md framing
  ("blast radius ≠ defect risk") already guards this line; keep it.
- **Merging with `mrs`'s risk model (parked P2).** The `ProjectModel` extraction
  is actually the *prerequisite* for that decision — a shared model needs
  somewhere to live. Land the abstraction here first, then move it to a shared
  package; that sequence answers the cross-repo question without a big-bang.

## 9. Suggested sequencing

Each step is independently shippable and testable with fixture strings (same
style as the existing `node --test` suites — no repo fixtures needed except the
graph pass, which can use a temp dir like `tests/risk.test.mjs` already does).

**This section is now realized as spec documents** — tackle one at a time:

| Order | Doc | Covers |
| --- | --- | --- |
| 1 | `SPEC-project-model.md` (P0) | §2 profile seam + §5 generic floor + detection; blocks everything |
| 2 | `SPEC-import-graph.md` (P1) | §4 one graph pass + MR-head-ref branch-accurate scoring |
| 3 | `SPEC-profiles-go-py-rs.md` (P2) | §3 go/python/rust rule tables |
| 4 | `SPEC-sensitivity-content-rules.md` (P2) | §6 content-signal destructive-op rules (independent of 1–3) |
| 5 | `TICKET-content-hash-chunk-ids.md` (P1) | §7 force-push content-delta fix (independent of 1–4) |
| 6 | `TICKET-housekeeping.md` (P2) | §7 CI, stale `docs/README.md`, roadmap link (do anytime) |

Independent of the language track: items 4, 5, 6 have no dependencies and can
be picked up in any order.
