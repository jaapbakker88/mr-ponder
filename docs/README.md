# mr-ponder (`mrp`)

> **Vision** — reviewing large, AI-assisted code-change MRs should be tractable
> for the human in the loop, not a war of attrition against line count.
>
> **Mission** — help the reviewer *make connections* and *see issues* across a
> big change without slogging through the whole diff line by line.
>
> **Goal** — surface the risky and related parts first, and give the reviewer a
> private space to connect the dots, so understanding comes from structure and
> relationships rather than sequential reading.

`git add -p`, but for **reviewing** an existing GitLab merge request instead of
staging changes. Step through a MR's diff hunk-by-hunk — risk-first — and attach
**private** notes, tags, and chunk-to-chunk links so you can connect the dots
across a large change without holding the whole thing in your head.

It is a separate tool from `mrs` (the MR dashboard); they share nothing but the
authenticated `glab` CLI.

## Why

AI-assisted development produces large, high-blast-radius MRs faster than a human
can read them top-to-bottom. `mrp` reframes the review as:

- **risk-first, consequence-weighted** — chunks are ordered by a risk score where
  a path **sensitivity** overlay (auth / money / migrations / infra / …) dominates,
  import **fan-out** (log-dampened) is one signal not the signal, tests sink, and
  files whose blast radius can't be measured sort *up* (fail-loud). Order is
  toggleable between **risk** (flat priority queue) and **file** (grouped, read in
  place) with `o`.
- **a thinking tool** — notes/tags/links are local and private by default, so you
  can jot half-formed thoughts and link related chunks while you build a mental
  model. Promoting a note to a real GitLab comment is a **deliberate** action (`P`).
- **honest coverage** — a chunk is *acked* (`space`, manual "done") separately from
  *engaged* (auto-set once its full body scrolled into view). The header reports
  both plus a "risky unseen" gate, so "seen" can't silently lie.
- **incremental** — after a force-push, chunks new since your last review are
  flagged `[new]` and filterable (`d`), so re-review focuses on the delta.
- **spatially aware** — a persistent sidebar shows the whole change (files →
  chunks with ack/engaged/note/link/tag markers) so you always know where you are.

## Usage

```
mrp <iid>                     review MR !<iid>
mrp <iid> --project a/b/c     override project
mrp <iid> --refetch           re-pull the diff (after a force-push)

mrp <iid> --export            emit the review as JSON (annotated chunks only)
  [--format json|md]          json (default) or a Markdown handoff summary
  [--all]                     include every chunk with its risk score (triage)
  [--out PATH]                write to a file instead of stdout
```

Environment:

- `MR_PROJECT`  — default project path.
- `MR_REPO_DIR` — local checkout used to compute import fan-out (blast radius).
- `EDITOR`      — editor used for notes (default `vi`).

Sensitivity rules are configurable at `~/.config/mrp/sensitivity.json`
(`[{ "pattern": "<regex>", "weight": <n>, "label": "<tag>" }, …]`); sensible
defaults ship built-in. This file is risk-relevant — version it, review it.

## Keys

Shortcuts are caps-lock-tolerant (case-insensitive), except `g`/`G` (top/bottom)
and `P` (promote), which are deliberately case-significant.

| Key | Action |
| --- | --- |
| `Tab` | switch focus: **sidebar** (move between chunks) ↔ **hunk** (scroll the diff) |
| `j`/`k` `↓`/`↑` | sidebar focus: prev/next chunk · hunk focus: scroll a line |
| `PgUp`/`PgDn` (or `Ctrl+u`/`Ctrl+d`) | scroll the hunk a page |
| `[` / `]` | jump to prev / next file |
| `{` / `}` | jump to prev / next **annotated** chunk (retrace your trail) |
| `g` / `G` | top / bottom (of the chunk list, or of the hunk when focused) |
| `space` | **ack** the chunk ("done"); a chunk auto-becomes *seen* once fully scrolled |
| `n` | add a note (opens `$EDITOR`) |
| `P` | **promote** the chunk's note to a GitLab comment (confirm `y`) |
| `t` | add a tag |
| `l` | link this chunk → pick a suggestion (`1`–`9`) or `f` to free-pick |
| `/` | text filter |
| `u` / `s` / `d` | unseen-only / shared-only / delta(new-since-last-review)-only |
| `e` | cycle test filter: all → hide tests → only tests |
| `o` | toggle order: risk ↔ file |
| `z` | undo last note/tag/link/ack |
| `?` `q` | help / quit |

State is saved on every change.

## Architecture

Plain Node ESM + [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).
Written with `React.createElement` (aliased `h`) rather than JSX so it runs under
`node` with **no build/transpile step**.

```
mrp.mjs                 entry: parse args → preflight → fetch → score → reconcile → render|export
src/gitlab.mjs          async wrapper over `glab` (preflight, api, MR detail/changes, post diff-note)
src/diff.mjs            parse unified diffs into individual @@ hunks ("chunks")
src/paths.mjs           shared path helpers (SHARED_RE, TEST_RE, importSpec) — one source of truth
src/sensitivity.mjs     path-based risk overlay (auth/money/migrations/…), config-driven
src/risk.mjs            score/order chunks (sensitivity + log-dampened fan-out + unknown); orderChunks
src/suggest.mjs         rank link candidates (same file / same tag / import edge)
src/store.mjs           per-MR local state (seen/engaged/notes/tags/links + reconcile/delta), keyed by SHA
src/export.mjs          build the structured review artifact (JSON schema + Markdown)
src/ui.mjs              the two-pane Ink TUI (sidebar map + hunk pane)
tests/                  node --test unit tests for the pure modules (run: npm test)
```

Data flow per run:

1. `preflight` (glab installed + authenticated) → friendly error otherwise.
2. `fetchMrDetail` + `fetchMrChanges` (`glab api`).
3. `parseChanges` → flat list of chunks (one per `@@` hunk), each with a **stable
   id** = `file@oldStart:newStart` so annotations re-attach after a re-fetch.
4. `scoreChunks` + `riskOrder` → risk-sorted (sensitivity-dominant, fan-out
   log-dampened, unknowns nudged up, tests sunk).
5. `buildImportEdges` → producer/consumer map for link suggestions.
6. `loadState` + `reconcile` → merge persisted annotations; detect a changed head
   SHA (force-push), flag orphaned ids, and compute `newIds` (the delta since the
   last reviewed revision).
7. `--export` → emit JSON/Markdown and exit; otherwise `render(<App>)`.

### State storage

One JSON file per MR:

```
~/.local/share/mrp/<project-slug>/<iid>.json
{ project, iid, headSha, fetchedAt, reviewedChunkIds[],
  seen{}, engaged{}, notes{ id: [{text, at, promoted?}] }, tags{}, links[] }
```

Keyed by `headSha` so a force-push is *detected* (SHA mismatch → warn), never
silently mis-attaching notes to shifted lines. `reviewedChunkIds` records the
revision's chunk set so re-review can show only the delta; `engaged` is the
observed (vs. self-reported) coverage signal; a note's `promoted` block records
if/when it was posted to GitLab.

## Design decisions

See `docs/DECISIONS.md` for the rationale — including the **threat-model
assessment** (why blast radius ≠ defect risk, why "seen" must not lie, why
local-first is an on-ramp not an endpoint) and its priority-ordered adoption gate.
See `docs/SPEC-promote-and-export.md` for the promote/export design.

## Known gaps / next

- Keyboard/visual behavior is verified by tests + boot, but the interactive *feel*
  needs a real TTY — Ink can't be driven headlessly.
- Sensitivity weights and the "engaged" bar are first calibrations — tune against
  real reviewer-note density (which the export feedback loop enables).
- Incremental delta is by chunk **identity** (`file@oldStart:newStart`), not true
  content-diff: a chunk whose content changed but start lines held isn't flagged.
- Fan-out is measured against the local checkout (usually `develop`), not the MR
  branch — newly-shared files can be under-scored (P2).
- `mrp`'s `SHARED_RE` is stricter than `mrs`'s; the two tools should share one risk
  model so triage and deep-read agree on "risky" (P2, cross-repo decision).
- Promote uses coarse (hunk-first-line) anchoring; line-precise notes are a follow-up.
