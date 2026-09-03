# New Signals + Presets (PR 2)

Type: **task**
Blocked by: [Migration Path](TICKET-risk-migration.md) — PR 1 must land first
Blocks: *(nothing)*

## Question

*(This ticket is a task, not a decision — the decisions are all made. It tracks
the implementation work that must follow PR 1.)*

Implement the three git-signal stages, the git signal fetcher, and the three
non-default presets, as specified in the resolved tickets.

## Work items

- [ ] Git signal fetcher in `src/pipeline.mjs`
      (spec: [Git Signal Fetcher](TICKET-risk-git-signal-fetcher.md))
- [ ] `src/stages/churn.mjs`
- [ ] `src/stages/recency.mjs`
- [ ] `src/stages/authorship.mjs`
      (spec: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md))
- [ ] Built-in presets `security`, `refactor`, `db-migration` in the stage registry
      (spec: [Preset Definitions](TICKET-risk-presets.md))
- [ ] `--list-presets` output updated to include new presets
- [ ] Tests for each new stage against fixture chunks
- [ ] Integration test: `--preset security` on a fixture MR with repoDir present
      produces different ordering than `default`

## Prerequisite

PR 1 (runner + default pipeline) merged and the parity test green.
