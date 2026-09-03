# CLI & Preset Activation

Type: **grilling + prototype**
Blocked by: [Config Schema](TICKET-risk-config-schema.md)
Blocks: [Migration Path](TICKET-risk-migration.md)
**Status: RESOLVED**

## Resolution

No `--pipeline` flag. `MR_PRESET` env var supported. Unknown preset = hard error.
`--list-presets` prints available presets with descriptions.

### Activation precedence (highest wins)

```
1. --preset <name>          CLI flag
2. MR_PRESET=<name>         Environment variable
3. "pipeline": [...]        Active config file (inline pipeline)
4. "preset": "<name>"       Active config file (named preset)
5. built-in "default"       Implicit fallback
```

Active config = `.mrp.json` in repo root if present, else `~/.config/mrp/config.json`.

### New CLI flags

```
--preset <name>     Activate a named preset (built-in or user-defined).
--list-presets      Print available presets with one-line descriptions, then exit.
```

### `--list-presets` output shape

```
Available presets (active config: ~/.config/mrp/config.json)

  default      General-purpose MR review. Reproduces the classic mrp scoring.
  security     Auth/money/infra-heavy MRs. Sensitivity dominant; authorship weighted up.
  refactor     Large mechanical rewrites. Fan-out dominant; churn expected and dampened.
  db-migration Schema change MRs. Migration/SQL rules maximised; size amplified.

  myPreset     (user-defined) [no description]
```

### Error on unknown preset

```
mrp: unknown preset "foo"
Available presets: default, security, refactor, db-migration, myPreset
```

Exit 1. Never silently falls back to `default`.

---

## Question

How does a user activate a preset or pipeline config — at the CLI, via env var,
via config file — and how do the activation layers combine?

**Proposed precedence (highest wins):**

```
--preset <name>  (CLI flag)
--pipeline <path>  (CLI flag pointing to a JSON file)
"preset" field in repo config  (.mrp/config.json)
"pipeline" field in repo config
"preset" field in user config  (~/.config/mrp/config.json)
"pipeline" field in user config
built-in default pipeline
```

**What to decide here:**
1. Should `--pipeline` accept a path to a JSON file, or is that over-engineering
   (repo config already covers the "load a pipeline from disk" case)?
2. Is an env var (`MR_PRESET=security`) needed, or is the CLI flag sufficient?
   Useful for shell aliases like `alias mrp-sec='MR_PRESET=security mrp'`.
3. How does activation interact with full-replace config merge (repo replaces
   user entirely) — does `--preset` select from the *active* config's preset
   definitions, or always from the built-ins?
4. What does `mrp --list-presets` look like? Should the tool be able to print
   available presets (built-in + user-defined) so the user doesn't have to read
   source?
5. When a named preset is not found (typo, removed built-in), should mrp hard-
   error or fall back to `default` with a warning?
