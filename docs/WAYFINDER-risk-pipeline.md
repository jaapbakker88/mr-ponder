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

*(none yet — charting complete, no tickets resolved)*

## Not yet specified

- Complexity signal (separate feature; will need its own wayfinder once the
  pipeline foundation exists)

## Out of scope

- **npm publishing** — module boundary will be clean but no publish in this
  effort. Revisit once the API has stabilised through real use.
- **Complexity signal** — own feature, own spec. Not fog — genuinely separate.
