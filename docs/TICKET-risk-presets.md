# Preset Definitions

Type: **grilling + prototype**
Blocked by: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md), [Config Schema](TICKET-risk-config-schema.md)
Blocks: [Migration Path](TICKET-risk-migration.md)

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
