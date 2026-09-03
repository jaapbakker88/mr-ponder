# Built-in Stage Catalog

Type: **grilling + prototype**
Blocked by: [Stage API Contract](TICKET-risk-stage-api-contract.md), [Git Signal Fetcher](TICKET-risk-git-signal-fetcher.md)
Blocks: [Preset Definitions](TICKET-risk-presets.md), [Migration Path](TICKET-risk-migration.md)
**Status: RESOLVED**

## Resolution

All stages are separate (composable). Authorship models "few authors = higher risk".
`sensitivity` reads pre-computed `ctx.sensitivity`.

### Catalog

Each stage is a factory `create(params) → (chunk, ctx) → number`. Params shown with defaults.

| Name | Formula | Params | Notes |
|---|---|---|---|
| `sensitivity` | `ctx.sensitivity` | — | Reads pre-computed value; runner always computes this for display |
| `fanOut` | `min(log10(fan+1) * multiplier, cap)` | `multiplier: 115`, `cap: 300` | Log-dampened reach; 0 for non-shared |
| `churn` | `log10(ctx.churn+1) * weight` (null → 0) | `weight: 80`, `window: 90` | window passed to git fetcher |
| `recency` | `ctx.lastTouchedDaysAgo >= staleDays ? weight : 0` (null → 0) | `weight: 60`, `staleDays: 180` | Step function: stale or not |
| `authorship` | `weight / (ctx.authorCount + 1)` (null → 0) | `weight: 40` | More authors → lower delta |
| `sharedBonus` | `chunk.shared ? bonus : 0` | `bonus: 50` | Shared-module nudge |
| `unknownBonus` | `ctx.fanOutFailed ? bonus : 0` | `bonus: 75` | Fail-loud for unassessable reach |
| `testSink` | `chunk.isTest ? -penalty : 0` | `penalty: 1000` | De-prioritise tests |
| `metaOnlySink` | `chunk.metaOnly ? -penalty : 0` | `penalty: 900` | De-prioritise pure renames/deletes |
| `sizeTiebreak` | `min(chunk.added + chunk.removed, cap) / divisor` | `cap: 100`, `divisor: 10` | Max +10; breaks score ties only |

### Module locations

```
src/stages/
  sensitivity.mjs
  fanOut.mjs
  churn.mjs
  recency.mjs
  authorship.mjs
  sharedBonus.mjs
  unknownBonus.mjs
  testSink.mjs
  metaOnlySink.mjs
  sizeTiebreak.mjs
```

Each exports `default` (factory) and `meta` (name + params schema).

### Default pipeline (reproduces current hardcoded formula, no new signals)

```jsonc
[
  { "name": "sensitivity" },
  { "name": "fanOut" },
  { "name": "sharedBonus" },
  { "name": "unknownBonus" },
  { "name": "testSink" },
  { "name": "metaOnlySink" },
  { "name": "sizeTiebreak" }
]
```

`churn`, `recency`, `authorship` are NOT in the default pipeline — they require
`repoDir` and are opt-in via the `security`/`refactor` presets or explicit config.

---

## Question

What built-in stages ship with mrp, what are their names (for config), what
parameters do they accept, and what are their defaults?

The current hardcoded formula broken into candidate stages:

| Stage name | Current value | Tunable params | Notes |
|---|---|---|---|
| `sensitivity` | summed rule weights | *(rules are already configurable)* | Dominant signal |
| `fanOut` | `log10(n+1)*115`, cap 300 | `multiplier`, `cap` | Log-dampened reach |
| `sharedBonus` | +50 | `bonus` | Shared-module nudge |
| `unknownBonus` | +75 | `bonus` | Fail-loud for unassessable |
| `testSink` | -1000 | `penalty` | De-prioritise tests |
| `metaOnlySink` | -900 | `penalty` | De-prioritise pure renames |
| `sizeTiebreak` | `min(churn,100)/10` | `cap`, `divisor` | Breaks score ties |

New stages (require git signal fetcher):

| Stage name | Signal used | Proposed default | Params |
|---|---|---|---|
| `churn` | commit count in window | `+weight * log(count+1)` | `weight`, `window` (days) |
| `recency` | days since last touch | `+weight` if stale | `weight`, `staleDays` |
| `authorship` | distinct author count | `+weight / authorCount` (more authors = more eyes, lower risk?) | `weight` — **direction TBD** |

**What to decide here:**
1. Are `sharedBonus`, `unknownBonus`, `testSink`, `metaOnlySink`, `sizeTiebreak`
   proper named stages, or are they baked into a single `defaults` stage? Named
   stages are more composable; a single stage is simpler config.
2. `authorship` signal direction — high author count means "well-reviewed file"
   (lower risk) or "many hands, unclear ownership" (higher risk)? Probably
   caller-configurable via a signed weight, with the default leaning toward
   "unclear ownership" for first-time contributors.
3. Should `sensitivity` be a stage that re-runs rule matching, or should it read
   pre-computed `ctx.sensitivity` / `ctx.sensLabels` (already in context from
   the runner)?
4. Are there any stages that shouldn't be removable from a pipeline (e.g.
   `testSink`) for safety, or is everything optional?
5. Stage ordering convention — does the pipeline sum deltas in declaration order,
   or does order not matter (pure sum)?
