# Wayfinder: Configurable Risk Pipeline

## Destination

A configurable, pipeline-based risk scoring engine for mrp — pluggable stages
(built-in or user-supplied JS), named presets, per-repo and per-user config, and a
clean module boundary so the whole thing can be extracted as a standalone package
later without a rewrite. The hardcoded formula in `src/risk.mjs` is replaced by a
pipeline runner; the **default pipeline reproduces the current behaviour exactly**
so there is no observable change unless the user opts in.

## Notes

Domain: mr-ponder (`/home/bakkerja/work/mr-ponder`).
Key files: `src/risk.mjs` (scoring formula + fan-out), `src/sensitivity.mjs`
(path-sensitivity rules and config loading).
Backing: local markdown in `docs/`. Tickets are `TICKET-risk-*.md` files alongside
this map.
Skills to call per ticket: grilling, domain-modeling.

**Decisions locked in charting:**

| # | Decision | Answer |
|---|---|---|
| 1 | Publishing scope | Extractable in-repo module; no npm publish yet |
| 2 | Scorer shape | Pipeline of stages |
| 3 | New signals in scope | Churn, recency, authorship |
| 4 | Config merge | Full replace — repo config replaces user config entirely |
| 5 | Stage interface | Runner pre-fetches all signals; stages are pure `(chunk, ctx) → number` |
| 6 | Config format | Array of stage objects; `name` for built-ins, `path` for custom, inline params on both |
| 7 | Presets | Named configs shipped with mrp; activated by `--preset <name>` or config field |
| 8 | Complexity signal | Separate future feature, not part of this effort |

## Decisions so far

- [Signal Context Schema](TICKET-risk-signal-context-schema.md): stage sig is `(chunk, ctx) → number`; missing git signals are `null`; runner freezes ctx before calling stages.
- [Config Schema](TICKET-risk-config-schema.md): one `config.json`; `sensitivity.json` is legacy fallback; `.mrp.json` at repo root for repo-level config (full replace); `pipeline` beats `preset` when both present.
- [Stage API Contract](TICKET-risk-stage-api-contract.md): factory pattern `create(params) → (chunk, ctx) → number`; async allowed; failed stage = skip + warn (delta 0); ESM only.
- [Git Signal Fetcher](TICKET-risk-git-signal-fetcher.md): single `git log --follow` pass per file; days-based churn window (default 90); author identity by email; parallel fetches; absent repoDir → all git signals null.
- [CLI & Preset Activation](TICKET-risk-cli-activation.md): `--preset` flag + `MR_PRESET` env var; no `--pipeline` flag; unknown preset = hard error; `--list-presets` prints available presets with descriptions.
- [Built-in Stage Catalog](TICKET-risk-builtin-stages.md): 10 separate named stages; authorship formula `weight/(authorCount+1)`; sensitivity reads ctx; churn/recency/authorship opt-in (not in default pipeline).
- [Preset Definitions](TICKET-risk-presets.md): 4 self-contained presets (default/security/refactor/db-migration); pipeline-only, no rule overrides; git-signal stages degrade gracefully without repoDir.
- [Migration Path](TICKET-risk-migration.md): new `src/pipeline.mjs`; `risk.mjs` becomes display helpers + re-export shim; two PRs (runner+default first, signals+presets second); parity test in PR 1; PR 2 tracked in [TICKET-risk-signals-and-presets.md](TICKET-risk-signals-and-presets.md).

## Not yet specified

- Complexity signal (separate feature; needs its own wayfinder once the pipeline
  foundation exists)
- PR 2 edge cases: git signal fetcher behaviour on shallow clones, very large
  histories, binary files

## Out of scope

- **npm publishing** — module boundary will be clean but no publish in this
  effort. Revisit once the API has stabilised through real use.
- **Complexity signal** — own feature, own spec. Not fog — genuinely separate.
