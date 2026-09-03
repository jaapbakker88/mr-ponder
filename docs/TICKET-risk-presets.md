# Preset Definitions

Type: **grilling + prototype**
Blocked by: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md), [Config Schema](TICKET-risk-config-schema.md)
Blocks: [Migration Path](TICKET-risk-migration.md)
**Status: RESOLVED**

## Resolution

Four self-contained presets (no inheritance). Pipeline-only — no sensitivity rule overrides.

---

### `default`

General-purpose MR review. Reproduces the classic hardcoded formula exactly.
No git signals required.

```json
[
  { "name": "sensitivity" },
  { "name": "fanOut",       "multiplier": 115, "cap": 300 },
  { "name": "sharedBonus",  "bonus": 50 },
  { "name": "unknownBonus", "bonus": 75 },
  { "name": "testSink",     "penalty": 1000 },
  { "name": "metaOnlySink", "penalty": 900 },
  { "name": "sizeTiebreak", "cap": 100, "divisor": 10 }
]
```

---

### `security`

Auth/money/infra-heavy MRs. Authorship is a strong signal (unfamiliar ownership
near sensitive code is a red flag). Recency window widened — a stale auth file
suddenly changed deserves extra scrutiny. `unknownBonus` doubled so unassessable
sensitive files sort firmly to the top.

Requires `repoDir` for git signals; degrades gracefully to near-`default` without it.

```json
[
  { "name": "sensitivity" },
  { "name": "fanOut",       "multiplier": 100, "cap": 200 },
  { "name": "authorship",   "weight": 120 },
  { "name": "recency",      "staleDays": 365, "weight": 100 },
  { "name": "churn",        "weight": 50, "window": 180 },
  { "name": "sharedBonus",  "bonus": 50 },
  { "name": "unknownBonus", "bonus": 150 },
  { "name": "testSink",     "penalty": 1000 },
  { "name": "metaOnlySink", "penalty": 900 },
  { "name": "sizeTiebreak", "cap": 100, "divisor": 10 }
]
```

---

### `refactor`

Large mechanical rewrites. Fan-out is the primary signal — what matters is blast
radius, not logic bugs. Churn is expected and dampened. `sharedBonus` amplified
because shared-file changes are exactly what the reviewer should focus on.

Requires `repoDir` for churn; degrades gracefully without it.

```json
[
  { "name": "sensitivity" },
  { "name": "fanOut",       "multiplier": 170, "cap": 500 },
  { "name": "churn",        "weight": 20, "window": 90 },
  { "name": "sharedBonus",  "bonus": 120 },
  { "name": "unknownBonus", "bonus": 75 },
  { "name": "testSink",     "penalty": 1000 },
  { "name": "metaOnlySink", "penalty": 900 },
  { "name": "sizeTiebreak", "cap": 300, "divisor": 10 }
]
```

---

### `db-migration`

Schema change MRs. Sensitivity already dominates for migration/SQL paths (rules
weight 300–450). Fan-out is capped low — DB files are rarely imported widely.
Size is amplified: a 500-line migration is meaningfully riskier than a 20-line one.
Authorship weighted up — migrations written by someone new to the schema warrant care.

Requires `repoDir` for authorship; degrades gracefully without it.

```json
[
  { "name": "sensitivity" },
  { "name": "fanOut",       "multiplier": 80, "cap": 100 },
  { "name": "authorship",   "weight": 80 },
  { "name": "sharedBonus",  "bonus": 50 },
  { "name": "unknownBonus", "bonus": 75 },
  { "name": "testSink",     "penalty": 1000 },
  { "name": "metaOnlySink", "penalty": 900 },
  { "name": "sizeTiebreak", "cap": 500, "divisor": 5 }
]
```

---

## Question

What named presets ship with mrp, what does each one look like as a pipeline
config, and what reviewer intent does each serve?

**Candidate built-in presets:**

| Preset name | Intent | Key differences from default |
|---|---|---|
| `default` | General-purpose MR review | Reproduces current hardcoded formula exactly |
| `security` | Auth/money/infra-heavy MRs | Sensitivity weight multiplied up; authorship weighted higher (unfamiliar author = flag) |
| `refactor` | Large mechanical rewrites | Fan-out dominates; sensitivity weight reduced (refactors rarely introduce logic bugs); churn deprioritised (high churn is expected) |
| `db-migration` | Schema change MRs | `migration`/`sql` sensitivity rules pushed to max; size tiebreak amplified; tests pushed down further |

**What to decide here:**
1. Are these four the right set, or are some of these not worth shipping as
   built-ins (too narrow)?
2. Should presets be *additive* (delta on top of `default`) or *self-contained*
   (full pipeline declaration)? Self-contained is more explicit but more
   boilerplate; additive is terser but harder to reason about in isolation.
3. Where do built-in preset definitions live in the codebase — inline in the
   runner as JS objects, or as JSON files under `src/presets/`?
4. Can a user extend a built-in preset (e.g. `"extends": "security"` plus extra
   stages) or must they copy-paste the full pipeline? Out of scope for now or
   worth speccing?
5. How does the `--preset` CLI flag interact with an inline `pipeline` field in
   config — does inline always win, or is there a merge?
