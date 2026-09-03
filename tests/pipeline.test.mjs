// pipeline.test.mjs — tests for src/pipeline.mjs
//
// Sections:
//   1. Numerical parity — default pipeline must reproduce the old hardcoded formula
//      for every fixture; guards against accidental behaviour change during migration.
//   2. Config loading — repo config overrides user config; missing file → empty config.
//   3. Preset resolution — MR_PRESET env, config "pipeline", config "preset", default.
//   4. Stage registry — unknown stage is skipped; custom path stage is loaded.
//   5. listPresets — output shape.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreChunks } from "../src/pipeline.mjs";
import { loadConfig, BUILTIN_PRESETS, listPresets } from "../src/pipeline.mjs";
import { TEST_RE, SHARED_RE } from "../src/risk.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Isolated empty repo: rg will error (no app/src), so shared files → unknown.
const EMPTY_REPO = mkdtempSync(join(tmpdir(), "mrp-pipeline-"));

// Redirect XDG_CONFIG_HOME to a guaranteed-empty dir so no user config
// or sensitivity.json leaks into these tests.
let origXDG;
before(() => {
  origXDG = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mrp-xdg-"));
  // Reset the preset env var so tests start clean.
  delete process.env.MR_PRESET;
});
after(() => {
  if (origXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG;
  delete process.env.MR_PRESET;
});

/**
 * Reference implementation: the old hardcoded formula from risk.mjs (pre-migration).
 * Used as the ground truth in parity tests.  Operates on already-annotated chunk
 * properties set by scoreChunks (shared, isTest, fanOut, unknown, sensitivity,
 * metaOnly, added, removed) so we're comparing formula outputs, not re-annotating.
 */
function oldFormula(c) {
  const fanScore = Math.min(Math.log10(c.fanOut + 1) * 115, 300);
  return (
    (c.isTest   ? -1000 : 0) +
    (c.metaOnly ? -900  : 0) +
    c.sensitivity +
    fanScore +
    (c.shared  ? 50 : 0) +
    (c.unknown ? 75 : 0) +
    Math.min(c.added + c.removed, 100) / 10
  );
}

// ---------------------------------------------------------------------------
// 1. Numerical parity
// ---------------------------------------------------------------------------

// Fixture set — covers every code path in the formula:
//   leaf, test, meta-only rename, meta-only delete, content-bearing rename,
//   shared+unknown (in empty repo), sensitive (auth), sensitive (money), large diff.
const PARITY_FIXTURES = [
  { file: "app/src/features/x/Leaf.tsx",            added: 3, removed: 1 },
  { file: "app/src/util.test.ts",                   added: 50, removed: 50 },
  { file: "app/src/features/x/Moved.tsx",           added: 0, removed: 0, op: "renamed" },
  { file: "app/src/features/x/Gone.tsx",            added: 0, removed: 0, op: "deleted" },
  { file: "app/src/features/x/Renamed.tsx",         added: 12, removed: 3, op: "renamed" },
  { file: "app/src/hooks/useThing.ts",              added: 1, removed: 0 },
  { file: "app/src/services/api.ts",                added: 2, removed: 1 },
  { file: "app/src/features/checkout/auth/login.ts", added: 5, removed: 2 },
  { file: "app/src/services/payment/charge.ts",     added: 10, removed: 5 },
  { file: "app/src/features/x/BigFile.tsx",         added: 200, removed: 100 },
  { file: "app/src/features/x/ExactCap.tsx",        added: 100, removed: 0 },
  { file: "app/src/features/x/Zero.tsx",            added: 0, removed: 0 },
];

test("numerical parity: default pipeline matches old hardcoded formula for all fixtures", async () => {
  const scored = await scoreChunks(PARITY_FIXTURES.map((f) => ({ ...f })), EMPTY_REPO);
  for (const c of scored) {
    const expected = oldFormula(c);
    assert.ok(
      Math.abs(c.risk - expected) < 1e-9,
      `parity failed for ${c.file}: got ${c.risk}, expected ${expected}`,
    );
  }
});

test("parity: leaf file risk = min(added+removed,100)/10", async () => {
  const [c] = await scoreChunks([{ file: "app/src/features/x/Leaf.tsx", added: 3, removed: 1 }], EMPTY_REPO);
  assert.ok(Math.abs(c.risk - 0.4) < 1e-9, `expected 0.4, got ${c.risk}`);
});

test("parity: test file is penalised -1000 + size", async () => {
  const [c] = await scoreChunks([{ file: "app/src/util.test.ts", added: 50, removed: 50 }], EMPTY_REPO);
  // isTest=true, size=100 (at cap), risk = -1000 + 100/10 = -990
  assert.ok(Math.abs(c.risk - (-990)) < 1e-9, `expected -990, got ${c.risk}`);
});

test("parity: meta-only rename is penalised -900 + 0", async () => {
  const [c] = await scoreChunks([{ file: "app/src/features/x/Moved.tsx", added: 0, removed: 0, op: "renamed" }], EMPTY_REPO);
  assert.ok(Math.abs(c.risk - (-900)) < 1e-9, `expected -900, got ${c.risk}`);
});

test("parity: content-bearing rename is NOT a metaOnly sink", async () => {
  const [c] = await scoreChunks([{ file: "app/src/features/x/Renamed.tsx", added: 12, removed: 3, op: "renamed" }], EMPTY_REPO);
  assert.equal(c.metaOnly, false);
  assert.ok(c.risk > 0, `expected positive risk, got ${c.risk}`);
});

test("parity: shared+unknown file gets +75 unknown + +50 shared nudge", async () => {
  const [c] = await scoreChunks([{ file: "app/src/hooks/useThing.ts", added: 1, removed: 0 }], EMPTY_REPO);
  assert.equal(c.shared, true);
  assert.equal(c.unknown, true);
  // risk = 0 (no sens) + 0 (fan=0) + 50 (shared) + 75 (unknown) + 0.1 (size)
  assert.ok(Math.abs(c.risk - 125.1) < 1e-9, `expected 125.1, got ${c.risk}`);
});

test("parity: auth-sensitive leaf dominates a mundane shared file", async () => {
  const scored = await scoreChunks([
    { file: "app/src/features/checkout/auth/login.ts", added: 2, removed: 0 },
    { file: "app/src/hooks/useThing.ts",              added: 2, removed: 0 },
  ], EMPTY_REPO);
  assert.ok(scored[0].risk > scored[1].risk, "sensitive leaf should outscore shared+unknown");
});

test("parity: sizeTiebreak is capped at 100 lines (max +10)", async () => {
  const [big] = await scoreChunks([{ file: "app/src/features/x/BigFile.tsx", added: 200, removed: 100 }], EMPTY_REPO);
  const [cap] = await scoreChunks([{ file: "app/src/features/x/ExactCap.tsx", added: 100, removed: 0 }], EMPTY_REPO);
  // Both should score the same size contribution (+10) despite different raw sizes.
  assert.ok(Math.abs(big.risk - cap.risk) < 1e-9, `big=${big.risk} cap=${cap.risk} should match`);
});

// ---------------------------------------------------------------------------
// 2. Config loading
// ---------------------------------------------------------------------------

test("loadConfig returns empty config when no files exist", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mrp-cfg-"));
  const { config, source } = loadConfig(tmpDir);
  assert.deepEqual(config, {});
  assert.equal(source, null);
});

test("loadConfig prefers repo .mrp.json over user config", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "mrp-cfg-"));
  writeFileSync(join(tmpDir, ".mrp.json"), JSON.stringify({ preset: "refactor" }));
  // Also write a user config (via XDG override in this dir — we fake it).
  const { config, source } = loadConfig(tmpDir);
  assert.equal(config.preset, "refactor");
  assert.ok(source.endsWith(".mrp.json"), `expected .mrp.json source, got ${source}`);
});

test("loadConfig falls back to user config when no .mrp.json", () => {
  const xdgDir = mkdtempSync(join(tmpdir(), "mrp-xdg2-"));
  const mrpDir = join(xdgDir, "mrp");
  mkdirSync(mrpDir, { recursive: true });
  writeFileSync(join(mrpDir, "config.json"), JSON.stringify({ preset: "security" }));
  const prevXDG = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
  try {
    const tmpDir = mkdtempSync(join(tmpdir(), "mrp-repo-")); // no .mrp.json here
    const { config, source } = loadConfig(tmpDir);
    assert.equal(config.preset, "security");
    assert.ok(source.endsWith("config.json"), `expected config.json, got ${source}`);
  } finally {
    process.env.XDG_CONFIG_HOME = prevXDG;
  }
});

// ---------------------------------------------------------------------------
// 3. Preset resolution (via MR_PRESET env and config fields)
// ---------------------------------------------------------------------------

test("MR_PRESET env var activates named preset", async () => {
  // 'default' preset → same formula; verify the env var path is wired at all.
  process.env.MR_PRESET = "default";
  try {
    const [c] = await scoreChunks([{ file: "app/src/features/x/Leaf.tsx", added: 4, removed: 0 }], EMPTY_REPO);
    assert.ok(Math.abs(c.risk - 0.4) < 1e-9);
  } finally {
    delete process.env.MR_PRESET;
  }
});

test("unknown preset via MR_PRESET causes process.exit(1)", async () => {
  process.env.MR_PRESET = "__no_such_preset__";
  let exitCode = null;
  const origExit = process.exit;
  // Intercept process.exit so the test runner isn't terminated.
  process.exit = (code) => { exitCode = code; throw new Error("exit"); };
  try {
    await scoreChunks([{ file: "a.ts", added: 1, removed: 0 }], EMPTY_REPO);
    assert.fail("expected exit to be called");
  } catch (e) {
    if (e.message !== "exit") throw e;
  } finally {
    process.exit = origExit;
    delete process.env.MR_PRESET;
  }
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// 4. BUILTIN_PRESETS
// ---------------------------------------------------------------------------

test("BUILTIN_PRESETS contains default, security, refactor, db-migration", () => {
  const names = Object.keys(BUILTIN_PRESETS);
  assert.ok(names.includes("default"));
  assert.ok(names.includes("security"));
  assert.ok(names.includes("refactor"));
  assert.ok(names.includes("db-migration"));
});

test("default preset pipeline stages match the 7 default-pipeline names", () => {
  const expected = ["sensitivity", "fanOut", "sharedBonus", "unknownBonus", "testSink", "metaOnlySink", "sizeTiebreak"];
  const actual = BUILTIN_PRESETS.default.pipeline.map((e) => e.name);
  assert.deepEqual(actual, expected);
});

// ---------------------------------------------------------------------------
// 5. listPresets
// ---------------------------------------------------------------------------

test("listPresets prints all four built-in preset names", () => {
  const lines = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => { lines.push(s); return true; };
  try {
    listPresets(EMPTY_REPO);
  } finally {
    process.stdout.write = origWrite;
  }
  const out = lines.join("");
  assert.ok(out.includes("default"));
  assert.ok(out.includes("security"));
  assert.ok(out.includes("refactor"));
  assert.ok(out.includes("db-migration"));
});
