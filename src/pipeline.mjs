// pipeline.mjs — configurable risk-scoring pipeline.
//
// Responsibilities:
//   • Config loading: repo-level .mrp.json → user-level ~/.config/mrp/config.json
//     → legacy sensitivity.json fallback for rules.
//   • Preset resolution: --preset / MR_PRESET env / "pipeline" / "preset" / default.
//   • Stage registry for all built-in stages.
//   • Git signal fetcher: churn, recency, authorship via git log (parallel, cached).
//   • Pipeline runner: pre-fetch signals, build frozen ctx, sum stage deltas.
//
// scoreChunks(chunks, repoDir) is the public entry point and is re-exported by
// risk.mjs for backward compatibility.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { SHARED_RE, TEST_RE, importSpec } from "./paths.mjs";
import { sensitivity as sensitivityFn, loadRules, compileRules } from "./sensitivity.mjs";

// Stage imports — default-pipeline stages
import sensitivityFactory from "./stages/sensitivity.mjs";
import fanOutFactory from "./stages/fanOut.mjs";
import sharedBonusFactory from "./stages/sharedBonus.mjs";
import unknownBonusFactory from "./stages/unknownBonus.mjs";
import testSinkFactory from "./stages/testSink.mjs";
import metaOnlySinkFactory from "./stages/metaOnlySink.mjs";
import sizeTiebreakFactory from "./stages/sizeTiebreak.mjs";
// Stage imports — git-signal stages (PR 2)
import churnFactory from "./stages/churn.mjs";
import recencyFactory from "./stages/recency.mjs";
import authorshipFactory from "./stages/authorship.mjs";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Built-in stage registry
// ---------------------------------------------------------------------------

const STAGE_REGISTRY = new Map([
  ["sensitivity", sensitivityFactory],
  ["fanOut", fanOutFactory],
  ["sharedBonus", sharedBonusFactory],
  ["unknownBonus", unknownBonusFactory],
  ["testSink", testSinkFactory],
  ["metaOnlySink", metaOnlySinkFactory],
  ["sizeTiebreak", sizeTiebreakFactory],
  // git-signal stages
  ["churn", churnFactory],
  ["recency", recencyFactory],
  ["authorship", authorshipFactory],
]);

// ---------------------------------------------------------------------------
// Built-in presets
// ---------------------------------------------------------------------------
//
// PR 1 ships only "default" (the other three require churn/recency/authorship
// stages that land in PR 2).  All four are defined here so --list-presets shows
// the full set; stages absent from the registry degrade gracefully (skip + warn).

export const BUILTIN_PRESETS = {
  default: {
    description: "General-purpose MR review. Reproduces the classic mrp scoring.",
    pipeline: [
      { name: "sensitivity" },
      { name: "fanOut",       multiplier: 115, cap: 300 },
      { name: "sharedBonus",  bonus: 50 },
      { name: "unknownBonus", bonus: 75 },
      { name: "testSink",     penalty: 1000 },
      { name: "metaOnlySink", penalty: 900 },
      { name: "sizeTiebreak", cap: 100, divisor: 10 },
    ],
  },
  security: {
    description: "Auth/money/infra-heavy MRs. Sensitivity dominant; authorship weighted up.",
    pipeline: [
      { name: "sensitivity" },
      { name: "fanOut",       multiplier: 100, cap: 200 },
      { name: "authorship",   weight: 120 },
      { name: "recency",      staleDays: 365, weight: 100 },
      { name: "churn",        weight: 50, window: 180 },
      { name: "sharedBonus",  bonus: 50 },
      { name: "unknownBonus", bonus: 150 },
      { name: "testSink",     penalty: 1000 },
      { name: "metaOnlySink", penalty: 900 },
      { name: "sizeTiebreak", cap: 100, divisor: 10 },
    ],
  },
  refactor: {
    description: "Large mechanical rewrites. Fan-out dominant; churn expected and dampened.",
    pipeline: [
      { name: "sensitivity" },
      { name: "fanOut",       multiplier: 170, cap: 500 },
      { name: "churn",        weight: 20, window: 90 },
      { name: "sharedBonus",  bonus: 120 },
      { name: "unknownBonus", bonus: 75 },
      { name: "testSink",     penalty: 1000 },
      { name: "metaOnlySink", penalty: 900 },
      { name: "sizeTiebreak", cap: 300, divisor: 10 },
    ],
  },
  "db-migration": {
    description: "Schema change MRs. Migration/SQL rules maximised; size amplified.",
    pipeline: [
      { name: "sensitivity" },
      { name: "fanOut",       multiplier: 80, cap: 100 },
      { name: "authorship",   weight: 80 },
      { name: "sharedBonus",  bonus: 50 },
      { name: "unknownBonus", bonus: 75 },
      { name: "testSink",     penalty: 1000 },
      { name: "metaOnlySink", penalty: 900 },
      { name: "sizeTiebreak", cap: 500, divisor: 5 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mrp", "config.json");
}

function legacySensitivityPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mrp", "sensitivity.json");
}

/**
 * Load the active config.  Repo config (.mrp.json at cwd) fully replaces user
 * config when present.  Returns { config, source } where source is the resolved
 * path or null when no file was found.
 */
export function loadConfig(cwd) {
  const dir = cwd || process.cwd();

  // 1. Repo-level config
  const repoPath = join(dir, ".mrp.json");
  if (existsSync(repoPath)) {
    try {
      return { config: JSON.parse(readFileSync(repoPath, "utf8")), source: repoPath };
    } catch {
      process.stderr.write(`mrp: ignoring malformed ${repoPath}\n`);
    }
  }

  // 2. User-level config
  const userPath = userConfigPath();
  if (existsSync(userPath)) {
    try {
      return { config: JSON.parse(readFileSync(userPath, "utf8")), source: userPath };
    } catch {
      process.stderr.write(`mrp: ignoring malformed ${userPath}\n`);
    }
  }

  return { config: {}, source: null };
}

// ---------------------------------------------------------------------------
// Sensitivity rule loading (with legacy fallback)
// ---------------------------------------------------------------------------

function loadPipelineRules(config) {
  // Inline rules in config take precedence.
  if (Array.isArray(config.sensitivityRules)) {
    return compileRules(config.sensitivityRules);
  }

  // Legacy fallback: ~/.config/mrp/sensitivity.json (read-only; never written).
  // loadRules() already handles this path — it reads sensitivity.json or falls
  // back to DEFAULT_RULES.  The force-reload avoids serving a stale module-level
  // cache when a different config was active in the same process.
  return loadRules();
}

// ---------------------------------------------------------------------------
// Preset resolution
// ---------------------------------------------------------------------------

function allPresetNames(config) {
  return [
    ...Object.keys(BUILTIN_PRESETS),
    ...Object.keys(config.presets ?? {}),
  ];
}

function resolvePresetPipeline(name, config) {
  // User-defined presets override built-ins with the same name.
  if (config.presets?.[name]) {
    const p = config.presets[name];
    return Array.isArray(p) ? p : p.pipeline;
  }
  if (BUILTIN_PRESETS[name]) {
    return BUILTIN_PRESETS[name].pipeline;
  }
  // Unknown preset: hard error (never silently falls back to default).
  const available = allPresetNames(config).join(", ");
  process.stderr.write(`mrp: unknown preset "${name}"\nAvailable presets: ${available}\n`);
  process.exit(1);
}

/**
 * Resolve the pipeline array to run.  Precedence (highest wins):
 *   1. MR_PRESET env var (set by mrp.mjs from --preset before calling scoreChunks)
 *   2. "pipeline" field in active config
 *   3. "preset" field in active config
 *   4. Built-in "default"
 */
function resolvePipeline(config) {
  const envPreset = process.env.MR_PRESET;

  if (envPreset) return resolvePresetPipeline(envPreset, config);
  if (Array.isArray(config.pipeline)) return config.pipeline;
  if (config.preset) return resolvePresetPipeline(config.preset, config);

  return BUILTIN_PRESETS.default.pipeline;
}

// ---------------------------------------------------------------------------
// Stage instantiation
// ---------------------------------------------------------------------------

async function instantiateStages(pipeline, configSource) {
  const stages = [];
  for (const entry of pipeline) {
    const { name, path: customPath, ...params } = entry;
    let factory;
    let stageName = name || customPath || "(unknown)";

    if (name) {
      factory = STAGE_REGISTRY.get(name);
      if (!factory) {
        process.stderr.write(`mrp: unknown stage "${name}" — skipping (delta 0)\n`);
        continue;
      }
    } else if (customPath) {
      const base = configSource ? dirname(configSource) : process.cwd();
      const absPath = resolve(base, customPath);
      try {
        const mod = await import(absPath);
        factory = mod.default;
        if (!factory) throw new Error("no default export");
        stageName = mod.meta?.name ?? customPath;
      } catch (e) {
        process.stderr.write(`mrp: failed to load stage "${customPath}": ${e.message} — skipping (delta 0)\n`);
        continue;
      }
    } else {
      continue; // entry with neither name nor path
    }

    try {
      stages.push({ name: stageName, fn: factory(params) });
    } catch (e) {
      process.stderr.write(`mrp: stage "${stageName}" factory failed: ${e.message} — skipping (delta 0)\n`);
    }
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Fan-out signal (import blast-radius grep)
// ---------------------------------------------------------------------------

async function fanOutGrep(spec, repoDir) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `from ['"]${escaped}['"/]`;
  try {
    const { stdout } = await execFileP(
      "rg",
      ["-l", "-e", pattern, "-g", "*.ts", "-g", "*.tsx", "app/src"],
      { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 },
    );
    const files = stdout.split("\n").filter(Boolean);
    return { count: files.length, files, failed: false };
  } catch (e) {
    if (e && e.code === 1) return { count: 0, files: [], failed: false };
    return { count: 0, files: [], failed: true };
  }
}

// ---------------------------------------------------------------------------
// Git signal fetcher (churn / recency / authorship)
// ---------------------------------------------------------------------------

const NULL_GIT_SIGNALS = { churn: null, lastTouchedDaysAgo: null, authorCount: null, primaryAuthor: null };

/**
 * Fetch all three git signals for one repo-relative file path.
 * Two parallel git log invocations per file:
 *   1. Windowed  — commit list in the last `windowDays` days; derives churn +
 *      authorCount + primaryAuthor.
 *   2. Most-recent — single commit from full history; derives lastTouchedDaysAgo.
 * Both use --follow so renames across history are tracked correctly.
 *
 * Exported so tests can call it directly against a fixture repo.
 */
export async function fetchFileGitSignals(file, repoDir, windowDays = 90) {
  const sinceDate = new Date(Date.now() - windowDays * 86400 * 1000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD

  const [windowed, recent] = await Promise.allSettled([
    execFileP(
      "git",
      ["log", "--follow", "--format=%ae%x00%at", `--since=${sinceDate}`, "--", file],
      { cwd: repoDir },
    ),
    execFileP(
      "git",
      ["log", "--follow", "--format=%at", "-1", "--", file],
      { cwd: repoDir },
    ),
  ]);

  // --- Parse windowed result: churn + authorship ---
  let churn = 0;
  const authorMap = new Map(); // email → commit count
  if (windowed.status === "fulfilled") {
    const lines = windowed.value.stdout.split("\n").filter(Boolean);
    churn = lines.length;
    for (const line of lines) {
      const nul = line.indexOf("\x00");
      const email = nul >= 0 ? line.slice(0, nul) : line;
      if (email) authorMap.set(email, (authorMap.get(email) ?? 0) + 1);
    }
  }
  const authorCount = authorMap.size;
  let primaryAuthor = null;
  let maxCount = 0;
  for (const [email, count] of authorMap) {
    if (count > maxCount) { maxCount = count; primaryAuthor = email; }
  }

  // --- Parse most-recent commit: lastTouchedDaysAgo ---
  let lastTouchedDaysAgo = null;
  if (recent.status === "fulfilled") {
    const ts = parseInt(recent.value.stdout.trim(), 10);
    if (!isNaN(ts) && ts > 0) {
      lastTouchedDaysAgo = Math.floor((Date.now() / 1000 - ts) / 86400);
    }
  }

  return { churn, lastTouchedDaysAgo, authorCount, primaryAuthor };
}

/** Read the `window` param off the first `churn` stage in the pipeline, or 90. */
function getChurnWindow(pipeline) {
  const entry = pipeline.find((e) => e.name === "churn");
  return entry?.window ?? 90;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Annotate every chunk with classification properties and a risk score produced
 * by running the active pipeline.
 *
 * Signature is identical to the old risk.mjs implementation so existing callers
 * need no changes.
 */
export async function scoreChunks(chunks, repoDir) {
  const { config, source: configSource } = loadConfig(repoDir || process.cwd());
  const rules = loadPipelineRules(config);
  const pipeline = resolvePipeline(config);
  const stages = await instantiateStages(pipeline, configSource);

  // Pre-fetch fan-out counts for shared non-test files (one grep per distinct
  // import spec, all in parallel so a large MR doesn't serialize I/O).
  const specs = [
    ...new Set(
      chunks
        .filter((c) => SHARED_RE.test(c.file) && !TEST_RE.test(c.file))
        .map((c) => importSpec(c.file))
        .filter(Boolean),
    ),
  ];

  let fanCache = new Map();
  if (repoDir && specs.length) {
    const fans = await Promise.all(specs.map((s) => fanOutGrep(s, repoDir)));
    fanCache = new Map(specs.map((s, i) => [s, fans[i]]));
  }

  // Pre-fetch git signals for every unique file in parallel; cache by path so
  // multiple chunks from the same file share one git invocation.
  const windowDays = getChurnWindow(pipeline);
  const gitCache = new Map(); // file → Promise<GitSignals>
  if (repoDir) {
    for (const file of new Set(chunks.map((c) => c.file))) {
      gitCache.set(file, fetchFileGitSignals(file, repoDir, windowDays));
    }
  }

  for (const c of chunks) {
    const shared  = SHARED_RE.test(c.file);
    const isTest  = TEST_RE.test(c.file);

    let fanOut        = 0;
    let fanOutFailed  = false;
    let fanOutImporters = [];

    if (shared && !isTest) {
      const spec = importSpec(c.file);
      if (spec) {
        const r = fanCache.get(spec);
        if (r) {
          fanOut         = r.count;
          fanOutFailed   = r.failed;
          fanOutImporters = r.files;
        } else {
          // repoDir absent or spec not in cache → unassessable
          fanOutFailed = true;
        }
      } else {
        fanOutFailed = true;
      }
    }

    const { weight: sens, labels: sensLabels } = sensitivityFn(c.file, rules);
    // A metadata-only change (pure rename/delete with no added/removed lines) has
    // nothing in the hunk to review.  Content-bearing renames are NOT metaOnly.
    const metaOnly = (c.op === "renamed" || c.op === "deleted") && c.added + c.removed === 0;

    // --- Annotate chunk for UI display (matches old risk.mjs contract) ---
    c.shared      = shared;
    c.isTest      = isTest;
    c.fanOut      = fanOut;
    c.importers   = fanOutImporters;
    c.sensitivity = sens;
    c.sensLabels  = sensLabels;
    c.unknown     = fanOutFailed;
    c.metaOnly    = metaOnly;

    // --- Resolve git signals (awaited here; already in-flight in parallel) ---
    const git = repoDir ? ((await gitCache.get(c.file)) ?? NULL_GIT_SIGNALS) : NULL_GIT_SIGNALS;

    // --- Build frozen signal context for stages ---
    const ctx = Object.freeze({
      sensitivity:       sens,
      sensLabels,
      fanOut,
      fanOutFailed,
      fanOutImporters,
      churn:             git.churn,
      lastTouchedDaysAgo: git.lastTouchedDaysAgo,
      authorCount:       git.authorCount,
      primaryAuthor:     git.primaryAuthor,
    });

    // --- Run stages, sum deltas ---
    let risk = 0;
    for (const { name, fn } of stages) {
      try {
        const delta = await fn(c, ctx);
        risk += delta ?? 0;
      } catch (e) {
        process.stderr.write(`mrp: stage "${name}" error: ${e.message} — skipping\n`);
      }
    }
    c.risk = risk;
  }

  return chunks;
}

/**
 * Print available presets (built-in + user-defined from active config) and exit.
 * Called by mrp.mjs when --list-presets is given.
 */
export function listPresets(cwd) {
  const { config, source } = loadConfig(cwd);
  const configLabel = source
    ? source.replace(homedir(), "~")
    : "(no config file)";

  process.stdout.write(`Available presets (active config: ${configLabel})\n\n`);

  for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
    process.stdout.write(`  ${name.padEnd(14)}${preset.description}\n`);
  }

  const userPresets = config.presets ?? {};
  const userNames = Object.keys(userPresets).filter((n) => !BUILTIN_PRESETS[n]);
  if (userNames.length) {
    process.stdout.write("\n");
    for (const name of userNames) {
      const desc = userPresets[name]?.description ?? "[no description]";
      process.stdout.write(`  ${name.padEnd(14)}(user-defined) ${desc}\n`);
    }
  }

  process.stdout.write("\n");
}
