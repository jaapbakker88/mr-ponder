# CLI & Preset Activation

Type: **grilling + prototype**
Blocked by: [Config Schema](TICKET-risk-config-schema.md)
Blocks: [Migration Path](TICKET-risk-migration.md)

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
