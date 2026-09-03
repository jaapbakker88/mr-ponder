# New Signals + Presets (PR 2)

Type: **task**
Blocked by: [Migration Path](TICKET-risk-migration.md) — PR 1 must land first
Blocks: *(nothing)*
**Status: DONE** — shipped in the same commit as PR 1 (`5fdad76`).

## Work items

- [x] Git signal fetcher in `src/pipeline.mjs`
      (spec: [Git Signal Fetcher](TICKET-risk-git-signal-fetcher.md))
- [x] `src/stages/churn.mjs`
- [x] `src/stages/recency.mjs`
- [x] `src/stages/authorship.mjs`
      (spec: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md))
- [x] Built-in presets `security`, `refactor`, `db-migration` in the stage registry
      (spec: [Preset Definitions](TICKET-risk-presets.md))
- [x] `--list-presets` output updated to include new presets
- [x] Tests for each new stage against fixture chunks
- [x] Integration test: `--preset security` on a fixture MR with repoDir present
      produces different ordering than `default`

## Prerequisite

PR 1 (runner + default pipeline) merged and the parity test green.
