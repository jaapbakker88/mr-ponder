# Migration Path

Type: **grilling + prototype**
Blocked by: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md), [Config Schema](TICKET-risk-config-schema.md), [Preset Definitions](TICKET-risk-presets.md), [CLI & Preset Activation](TICKET-risk-cli-activation.md)
Blocks: *(nothing — last ticket before implementation)*

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
