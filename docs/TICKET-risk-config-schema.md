# Config Schema

Type: **grilling + prototype**
Blocked by: *(nothing — frontier)*
Blocks: [CLI & Preset Activation](TICKET-risk-cli-activation.md), [Preset Definitions](TICKET-risk-presets.md)
**Status: RESOLVED**

## Resolution

Single `config.json` file; `sensitivity.json` read as legacy fallback shim.
`pipeline` beats `preset` when both present in the same file.
Repo config is `.mrp.json` at the repo root (full replace over user config).

### File locations

| Layer | Path | Merge behaviour |
|---|---|---|
| User | `~/.config/mrp/config.json` | Base; used when no repo config |
| Repo | `.mrp.json` (repo root) | Full replace — replaces user config entirely for that repo |
| Legacy (read-only) | `~/.config/mrp/sensitivity.json` | Fallback if `sensitivityRules` absent from both configs; never written |

### Schema

```jsonc
{
  // Which built-in (or user-defined) preset to activate.
  // Ignored when "pipeline" is also present — pipeline wins.
  "preset": "default",

  // Explicit pipeline. Presence overrides "preset".
  // Stages run in declaration order; each returns a numeric delta.
  // Built-in stage names: see TICKET-risk-builtin-stages.md
  "pipeline": [
    { "name": "sensitivity" },
    { "name": "fanOut",       "multiplier": 115, "cap": 300 },
    { "name": "churn",        "window": 90,  "weight": 80  },
    { "name": "recency",      "staleDays": 180, "weight": 60 },
    { "name": "authorship",   "weight": 40  },
    { "name": "testSink",     "penalty": 1000 },
    { "name": "metaOnlySink", "penalty": 900  },
    { "name": "sharedBonus",  "bonus": 50   },
    { "name": "unknownBonus", "bonus": 75   },
    { "name": "sizeTiebreak", "cap": 100, "divisor": 10 },
    // Custom stage: path relative to the config file that declares it.
    { "path": "./stages/my-stage.js" }
  ],

  // Sensitivity rules. Replaces built-in defaults when present.
  // Legacy fallback: ~/.config/mrp/sensitivity.json if absent here.
  "sensitivityRules": [
    { "pattern": "(?:^|/)(auth|session)s?/", "weight": 500, "label": "auth" }
  ],

  // User-defined named presets (supplement built-ins; same schema as above).
  "presets": {
    "myPreset": {
      "pipeline": [
        { "name": "sensitivity" },
        { "name": "fanOut", "cap": 150 }
      ]
    }
  }
}
```

### Resolution rules (evaluated in order, first match wins)

1. CLI `--preset` flag → select named preset from active config
2. `"pipeline"` field in active config → use inline pipeline
3. `"preset"` field in active config → select named preset
4. Fall through to built-in `default` preset

Active config = `.mrp.json` if present in repo root, else `~/.config/mrp/config.json`.

---

## Question

What does the full config file look like — its location, filename, JSON schema,
and how the two config layers (user and repo) relate?

**Config file locations:**

User-level (already exists for sensitivity rules):
```
~/.config/mrp/config.json   (or keep sensitivity.json for rules, add config.json for pipeline?)
```

Repo-level (new):
```
<repo-root>/.mrp/config.json
```

Questions:
- Does the pipeline config live in the *existing* `sensitivity.json` alongside
  the sensitivity rules, or in a separate `config.json`? Separate is cleaner for
  the extractable-module goal; merged is fewer files.
- Should `.mrp/config.json` be committed to the repo (team-shared threat model)
  or gitignored (personal per-checkout tuning)? Probably committed — that's the
  whole point of repo-level config.

**Schema shape (draft):**

```jsonc
{
  // Which preset to activate by default (can be overridden by --preset CLI flag).
  "preset": "default",

  // OR: inline pipeline, which takes precedence over preset.
  "pipeline": [
    { "name": "sensitivity" },
    { "name": "fanOut", "multiplier": 115, "cap": 300 },
    { "name": "churn",  "window": 90, "weight": 80 },
    { "name": "recency", "staleDays": 180, "weight": 60 },
    { "name": "authorship", "weight": 40 },
    { "name": "testSink",   "penalty": 1000 },
    { "name": "metaOnlySink", "penalty": 900 },
    { "name": "sharedBonus",  "bonus": 50 },
    { "name": "unknownBonus", "bonus": 75 },
    { "name": "sizeTiebreak", "cap": 100, "divisor": 10 },
    // Custom stage: path relative to the config file that declares it.
    { "path": "./stages/my-stage.js" }
  ],

  // Sensitivity rules (currently in sensitivity.json — migrate here or keep separate?).
  "sensitivityRules": [
    { "pattern": "...", "weight": 500, "label": "auth" }
  ],

  // User-defined named presets (supplement the built-ins).
  "presets": {
    "myPreset": { "pipeline": [...] }
  }
}
```

**What to decide here:**
1. One config file or two (merge with `sensitivity.json` or new `config.json`)?
2. Repo config filename and whether it belongs in `.mrp/` or the root
3. Exact schema for a pipeline entry (required fields, optional params, path resolution)
4. Where sensitivity rules live in the new world
5. How `preset` and `pipeline` coexist — does inline `pipeline` always win, or
   can they be merged?
6. Whether user-defined presets are in scope for this effort or fog
