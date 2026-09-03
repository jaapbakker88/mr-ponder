# Migration Path

Type: **grilling + prototype**
Blocked by: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md), [Config Schema](TICKET-risk-config-schema.md), [Preset Definitions](TICKET-risk-presets.md), [CLI & Preset Activation](TICKET-risk-cli-activation.md)
Blocks: *(nothing — last ticket before implementation)*
**Status: RESOLVED**

## Resolution

New `src/pipeline.mjs` for the runner. `sensitivity.json` read silently as fallback.
Two PRs: runner + default pipeline first; new signals + presets second (tracked below).
Numerical parity test required in PR 1.

---

### Module split

| File | Responsibility after migration |
|---|---|
| `src/pipeline.mjs` | Pipeline runner, config loader, git signal fetcher, stage registry |
| `src/risk.mjs` | Display helpers (`riskGlyph`, `riskColor`, `riskOrder`, `orderChunks`, sidebar math); re-exports `scoreChunks` from `pipeline.mjs` for backward compat |
| `src/sensitivity.mjs` | Unchanged — still owns `loadRules` / `sensitivity()`; called by the `sensitivity` stage |
| `src/stages/*.mjs` | One file per built-in stage (see Built-in Stage Catalog) |

`scoreChunks` signature stays identical to today — callers (`mrp.mjs`) need no changes.

### Config loading (in `pipeline.mjs`)

```
1. Look for .mrp.json in repo root (cwd / git root)
2. If found → use it (full replace)
3. Else → look for ~/.config/mrp/config.json
4. If sensitivityRules absent in active config → silently read
   ~/.config/mrp/sensitivity.json as fallback (legacy shim, never written)
5. Resolve pipeline: --preset / MR_PRESET / "pipeline" / "preset" / default
   (see CLI & Preset Activation ticket for precedence)
```

### PR 1 — runner + default pipeline (zero behaviour change)

Scope:
- `src/pipeline.mjs` with runner, config loader, stage registry
- `src/stages/` with the 7 default-pipeline stages (sensitivity, fanOut,
  sharedBonus, unknownBonus, testSink, metaOnlySink, sizeTiebreak)
- Config loading + `--preset` / `MR_PRESET` / `--list-presets` CLI wiring
- `src/risk.mjs` thinned to display helpers + `scoreChunks` re-export
- **Numerical parity test**: fixture set of chunks scored by old formula and new
  `default` pipeline; assert scores are identical

PR 1 must not change any score for any user with no config file.

### PR 2 — new signals + presets *(follow-up, must be tracked)*

Scope:
- `src/stages/churn.mjs`, `recency.mjs`, `authorship.mjs`
- Git signal fetcher in `pipeline.mjs`
- Built-in presets: `security`, `refactor`, `db-migration`
- `--list-presets` output updated with new presets

> **Follow-up ticket needed**: create `TICKET-risk-signals-and-presets.md` before
> closing this branch, so PR 2 has a home and doesn't get lost.

### `suggest.mjs` (`buildImportEdges`)

Out of scope for this migration. It runs its own fan-out greps for the import
graph panel and does not go through `scoreChunks`. Left untouched.

---

## Question

How does the current hardcoded formula in `src/risk.mjs` get replaced by the
pipeline runner without breaking existing behaviour, and what does the transition
look like at the code level?

**Current state:**
- `scoreChunks(chunks, repoDir)` in `src/risk.mjs` contains the formula inline.
- `src/sensitivity.mjs` loads sensitivity rules from `~/.config/mrp/sensitivity.json`.
- No pipeline, no config for the scoring formula.

**Target state:**
- `scoreChunks` delegates to a pipeline runner.
- The runner loads config (user + repo), resolves stages, pre-fetches signals, runs
  the pipeline.
- The `default` preset produces scores numerically identical to today's formula.
- Users with no config notice no change.

**What to decide here:**
1. **Module boundary**: does `scoreChunks` stay in `src/risk.mjs` (now a thin
   wrapper over the runner), or does the runner live in a new file
   (`src/pipeline.mjs`) and `risk.mjs` becomes a backward-compat re-export?
2. **Sensitivity rules migration**: the existing `~/.config/mrp/sensitivity.json`
   is the user-level sensitivity config. Does it stay as-is (runner reads it
   separately) or does it get folded into the new `config.json`? If folded,
   is there a migration shim that reads the old path as a fallback?
3. **Numerical parity test**: should a test be written that runs the new `default`
   pipeline on a fixture set of chunks and asserts the scores match the old
   formula? This is the only way to guarantee the migration is transparent.
4. **Incremental vs big-bang**: is it worth introducing the runner with only the
   default pipeline first (no new signals, no presets) and landing the rest in
   follow-on PRs? Or does this ship as one change?
5. **`src/suggest.mjs` (`buildImportEdges`)**: that module also runs fan-out
   greps. Does the pipeline refactor touch it, or is it out of scope?
