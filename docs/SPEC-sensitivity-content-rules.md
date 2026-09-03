# Spec: content-signal sensitivity rules

**Status:** OPEN · **Priority:** P2 (small, self-contained) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §6

## Problem

Sensitivity rules (`src/sensitivity.mjs`) are **path-based only**. They say
where consequence lives (auth dirs, migrations, infra files) — but destructive
operations hiding in bland paths are invisible: a `DROP TABLE` inside a
"cleanup" util, `ON DELETE CASCADE` in a model, `eval(` on user input, an
`ON DELETE CASCADE`... The threat model in `docs/DECISIONS.md` is exactly
about AI confidently producing dangerous lines; the most dangerous lines often
sit in files whose *paths* are unremarkable.

## Design

### 1. New rule type: `content` rules

Extend the rule object shape alongside the existing path rules (backward
compatible — old config entries keep working):

```json
[
  { "pattern": "(?:^|/)(auth|...)/", "weight": 500, "label": "auth", "scope": "path" },
  { "pattern": "DROP\\s+TABLE", "weight": 400, "label": "destructive", "scope": "content" }
]
```

- `scope` defaults to `"path"` — absent field = today's behavior exactly.
- `scope: "content"` rules are tested against the chunk's **added lines only**
  (the `+`-side body), never context or removed lines. We review what the MR
  *introduces*; a removed `DROP TABLE` is good news, not risk.
- Case-insensitive like path rules (`sensitivity.mjs:59` compiles with `"i"`).

### 2. Seed rules — conservative, ~5

False positives cost reviewer trust (cry-wolf → ignored warnings), so the seed
set is deliberately tiny and high-precision:

| Pattern | Weight | Label | Rationale |
| --- | --- | --- | --- |
| `DROP\s+(TABLE|DATABASE|INDEX)` | 400 | destructive-sql | near-zero FP on added lines |
| `ON\s+DELETE\s+CASCADE` | 250 | destructive-sql | data-loss amplifier, silent by nature |
| `TRUNCATE\s+TABLE` | 300 | destructive-sql | same family |
| `eval\s*\(` | 250 | dynamic-exec | JS/Python footgun; FP on `reeval(`/`medieval(` blocked by `\b`-ish `eval\s*\(` prefix — keep `(?:^|[^a-z])eval\s*\(` |
| `--no-sandbox` | 300 | unsafe-flag | process-escape hatch for spawned browsers/electron |

Explicitly **rejected** for the seed set (too noisy — log why so it isn't
re-litigated): `innerHTML`, `sudo`, `chmod 777`, `curl | sh`, `!important`,
`any`/`as any`. Revisit individually only with export-loop evidence.

Weights sit below path-tier auth/money (500/450) so a bland-path destructive
line still ranks under a real auth-dir change; they sit above fan-out scores so
they can't be buried by reach. Same arithmetic discipline as the existing
model: consequence is categorical, reach is dampened.

### 3. Where it runs

`src/sensitivity.mjs` gains `sensitivityChunk(chunk, rules)`: path rules score
`chunk.file` as today; content rules score the joined added-lines text
(`diff.mjs` chunks already carry the body — verify field name: `added` count
vs. body lines; extraction from the chunk's line array, `+`-prefixed, minus
`+++` header). `risk.mjs` `scoreChunks` (line 97) calls the chunk variant
instead of the file variant. `sensLabels` accumulate from both scopes; the `⚠`
glyph logic is unchanged (any label ⇒ sensitive).

### 4. Config: same file, same layering

Rules continue to live in `~/.config/mrp/sensitivity.json`, default-seeded,
org-overridable, version-controlled per the README's guidance. The doc comment
in `DEFAULT_RULES` gains the `scope` field explanation and the cry-wolf
calibration note.

## Edge cases

- **Added line that's a test fixture** (`expect(query).toBe("DROP TABLE")`):
  test files already sink via `-1000`, which dominates any content weight.
- **Docs/README added lines** containing the pattern: `weight` applies... but
  docs changes have no code consequence. Accept the FP for v1 (rare, cheap) —
  a `docs/**` path exemption rule can be added as a path rule with negative
  weight if it proves annoying. Note it here so it's a known knob, not a
  surprise.
- **Migrations**: usually already caught by the path rule; content rule
  stacking is fine — weights sum by design (`sensitivity.mjs:70-76`).
- **Minified/generated code**: one giant added line matching many rules — cap
  content contribution per chunk at the max single rule weight × 2, so a
  machine-generated blob can't outrank a hand-written auth change. Small guard
  in `sensitivityChunk`.

## Out of scope

- Language-aware content rules (e.g. Rust `unsafe` blocks) — must wait for
  profiles to avoid FP explosion; note as follow-up.
- Removed-line rules (what the MR *deleted* that was dangerous) — interesting
  signal but the wrong direction for review-first ordering.

## Sequencing

1. Add `scope` handling + `sensitivityChunk` in `src/sensitivity.mjs`; keep
   `sensitivity(file, rules)` exported unchanged for compatibility.
2. Seed rules into `DEFAULT_RULES` with the calibration comment.
3. Tests: added-line-only matching (removed `DROP TABLE` ⇒ no label), label
   accumulation, test-sink dominance, minified-cap guard.
4. README: document `scope` in the sensitivity-config paragraph.

## Acceptance

- A chunk adding `DROP TABLE users;` in `src/utils/cleanup.ts` (bland path)
  gets label `destructive-sql`, ⚠ glyph, and sorts above mundane shared-file
  chunks — verified by a unit test with a fixture diff.
- The same line *removed* scores nothing extra.
- Existing path-rule behavior and all current tests unchanged.
