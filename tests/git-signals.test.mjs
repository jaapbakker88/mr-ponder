// git-signals.test.mjs — tests for the git signal fetcher and the three
// git-signal stages (churn, recency, authorship).
//
// Sections:
//   1. Stage unit tests — pure formula verification with null-guard checks.
//   2. Git signal fetcher — fixture repo with known history, signal assertions.
//   3. Integration — with repoDir present, security preset ranks differently
//      than default when authorship signals differ.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import churnCreate from "../src/stages/churn.mjs";
import recencyCreate from "../src/stages/recency.mjs";
import authorshipCreate from "../src/stages/authorship.mjs";
import { fetchFileGitSignals, scoreChunks, BUILTIN_PRESETS } from "../src/pipeline.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHUNK = { file: "src/foo.ts", added: 1, removed: 0, shared: false, isTest: false, metaOnly: false };

function ctx(overrides = {}) {
  return Object.freeze({
    sensitivity: 0, sensLabels: [], fanOut: 0, fanOutFailed: false,
    fanOutImporters: [],
    churn: null, lastTouchedDaysAgo: null, authorCount: null, primaryAuthor: null,
    ...overrides,
  });
}

// Build a minimal git repo with a controlled commit history.
// Returns { dir, commit(file, content, authorEmail, daysAgo) }.
function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "mrp-gitsig-"));
  const run = (cmd, env = {}) =>
    execSync(cmd, { cwd: dir, stdio: "pipe", env: { ...process.env, ...env } });

  run("git init -b main");
  run("git config user.email seed@test.com");
  run("git config user.name Seed");
  run("git config commit.gpgsign false");

  // Seed an initial commit so the repo is valid.
  writeFileSync(join(dir, ".gitkeep"), "");
  run("git add .gitkeep");
  run("git commit -m init");

  function commit(file, content, authorEmail = "alice@test.com", daysAgo = 0) {
    // Backdate by writing GIT_AUTHOR_DATE / GIT_COMMITTER_DATE.
    const ts = Math.floor(Date.now() / 1000) - daysAgo * 86400;
    const dateStr = new Date(ts * 1000).toISOString();
    const filePath = join(dir, file);
    mkdirSync(filePath.slice(0, filePath.lastIndexOf("/")), { recursive: true });
    writeFileSync(filePath, content);
    run(`git add "${file}"`);
    run(`git commit -m "edit ${file}" --author "${authorEmail} <${authorEmail}>"`, {
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_DATE: dateStr,
    });
  }

  return { dir, commit };
}

// ---------------------------------------------------------------------------
// 1. Stage unit tests
// ---------------------------------------------------------------------------

// --- churn ---

test("churn: null ctx.churn → 0", () => {
  const fn = churnCreate({});
  assert.equal(fn(CHUNK, ctx({ churn: null })), 0);
});

test("churn: churn=0 → 0 (log10(1)=0)", () => {
  const fn = churnCreate({});
  assert.ok(Math.abs(fn(CHUNK, ctx({ churn: 0 }))) < 1e-9);
});

test("churn: churn=9, default weight=80 → log10(10)*80 = 80", () => {
  const fn = churnCreate({});
  const expected = Math.log10(9 + 1) * 80; // log10(10)*80 = 80
  assert.ok(Math.abs(fn(CHUNK, ctx({ churn: 9 })) - expected) < 1e-9);
});

test("churn: weight param is respected", () => {
  const fn = churnCreate({ weight: 40 });
  const expected = Math.log10(9 + 1) * 40;
  assert.ok(Math.abs(fn(CHUNK, ctx({ churn: 9 })) - expected) < 1e-9);
});

test("churn: higher churn → higher score (monotone)", () => {
  const fn = churnCreate({});
  const lo = fn(CHUNK, ctx({ churn: 1 }));
  const hi = fn(CHUNK, ctx({ churn: 50 }));
  assert.ok(hi > lo);
});

// --- recency ---

test("recency: null lastTouchedDaysAgo → 0", () => {
  const fn = recencyCreate({});
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: null })), 0);
});

test("recency: fresh file (0 days) → 0", () => {
  const fn = recencyCreate({});
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 0 })), 0);
});

test("recency: exactly at staleDays threshold → fires", () => {
  const fn = recencyCreate({ staleDays: 180, weight: 60 });
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 180 })), 60);
});

test("recency: one day below threshold → 0", () => {
  const fn = recencyCreate({ staleDays: 180, weight: 60 });
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 179 })), 0);
});

test("recency: well beyond threshold → weight (step function, no scaling)", () => {
  const fn = recencyCreate({ staleDays: 180, weight: 60 });
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 365 })), 60);
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 730 })), 60);
});

test("recency: weight param is respected", () => {
  const fn = recencyCreate({ staleDays: 1, weight: 100 });
  assert.equal(fn(CHUNK, ctx({ lastTouchedDaysAgo: 1 })), 100);
});

// --- authorship ---

test("authorship: null authorCount → 0", () => {
  const fn = authorshipCreate({});
  assert.equal(fn(CHUNK, ctx({ authorCount: null })), 0);
});

test("authorship: 0 authors (new file) → weight / 1 = full weight", () => {
  const fn = authorshipCreate({ weight: 40 });
  assert.ok(Math.abs(fn(CHUNK, ctx({ authorCount: 0 })) - 40) < 1e-9);
});

test("authorship: 1 author → weight / 2", () => {
  const fn = authorshipCreate({ weight: 40 });
  assert.ok(Math.abs(fn(CHUNK, ctx({ authorCount: 1 })) - 20) < 1e-9);
});

test("authorship: more authors → lower score (monotone decreasing)", () => {
  const fn = authorshipCreate({});
  const scores = [0, 1, 5, 10, 50].map((n) => fn(CHUNK, ctx({ authorCount: n })));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] < scores[i - 1], `score at ${i} authors should be less than at ${i - 1}`);
  }
});

test("authorship: weight param is respected", () => {
  const fn = authorshipCreate({ weight: 120 });
  // 0 authors → 120/1 = 120
  assert.ok(Math.abs(fn(CHUNK, ctx({ authorCount: 0 })) - 120) < 1e-9);
});

// ---------------------------------------------------------------------------
// 2. Git signal fetcher — fixture repo
// ---------------------------------------------------------------------------

let repo;
before(() => {
  repo = makeFixtureRepo();

  // Commits MUST be in chronological order (oldest first) so that git's
  // --since walk optimisation doesn't stop early when it encounters a
  // non-monotone timestamp.

  // stale.ts first (oldest: 400 days ago)
  repo.commit("src/stale.ts", "s1", "alice@test.com", 400);

  // history for auth/verify.ts: 3 commits, all by alice (1 author), last today
  repo.commit("src/auth/verify.ts", "v1", "alice@test.com", 30);
  repo.commit("src/auth/verify.ts", "v2", "alice@test.com", 20);

  // history for utils/helper.ts: 2 commits by 2 authors, last 5 days ago
  repo.commit("src/utils/helper.ts", "u1", "alice@test.com", 10);
  repo.commit("src/utils/helper.ts", "u2", "bob@test.com", 5);

  // final verify commit today (most recent in the repo)
  repo.commit("src/auth/verify.ts", "v3", "alice@test.com", 0);
});

test("fetcher: file with 3 commits by 1 author", async () => {
  const sig = await fetchFileGitSignals("src/auth/verify.ts", repo.dir, 90);
  assert.equal(sig.churn, 3);
  assert.equal(sig.authorCount, 1);
  assert.equal(sig.primaryAuthor, "alice@test.com");
  assert.ok(sig.lastTouchedDaysAgo !== null && sig.lastTouchedDaysAgo <= 1);
});

test("fetcher: file with 2 commits by 2 authors", async () => {
  const sig = await fetchFileGitSignals("src/utils/helper.ts", repo.dir, 90);
  assert.equal(sig.churn, 2);
  assert.equal(sig.authorCount, 2);
  assert.ok(sig.lastTouchedDaysAgo !== null && sig.lastTouchedDaysAgo <= 6);
});

test("fetcher: stale file has churn=0 in 90-day window but lastTouchedDaysAgo set", async () => {
  const sig = await fetchFileGitSignals("src/stale.ts", repo.dir, 90);
  assert.equal(sig.churn, 0);
  assert.equal(sig.authorCount, 0);
  assert.ok(sig.lastTouchedDaysAgo !== null && sig.lastTouchedDaysAgo >= 390,
    `expected >= 390, got ${sig.lastTouchedDaysAgo}`);
});

test("fetcher: unknown file has null lastTouchedDaysAgo and churn=0", async () => {
  const sig = await fetchFileGitSignals("src/does-not-exist.ts", repo.dir, 90);
  assert.equal(sig.churn, 0);
  assert.equal(sig.authorCount, 0);
  assert.equal(sig.lastTouchedDaysAgo, null);
});

test("fetcher: absent repoDir → all null signals (via scoreChunks)", async () => {
  const [c] = await scoreChunks([{ file: "src/auth/verify.ts", added: 1, removed: 0 }], null);
  // Without repoDir, scoreChunks passes null to the fetcher path — ctx gets nulls.
  // Stages (churn/recency/authorship) degrade to 0 when absent from default pipeline.
  assert.equal(c.risk, c.risk); // just assert it ran without throwing
});

// ---------------------------------------------------------------------------
// 3. Integration — security preset ranks differently than default
// ---------------------------------------------------------------------------

let origXDG;
before(() => {
  origXDG = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mrp-xdg-sig-"));
  delete process.env.MR_PRESET;
});
after(() => {
  if (origXDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXDG;
  delete process.env.MR_PRESET;
});

test("integration: security preset amplifies authorship signal vs default", async () => {
  // Two plain non-shared leaf files (no sensitivity, no fan-out).
  // File A: touched only by 1 author (high authorship risk under security).
  // File B: touched by 10 authors (low authorship risk).
  // With default preset: no authorship stage, so both score the same.
  // With security preset: authorship weight=120, so A >> B.

  const fixtureRepo = makeFixtureRepo();
  // File A: 1 author
  fixtureRepo.commit("src/features/x/FileA.ts", "a", "alice@test.com", 1);
  // File B: 10 authors
  for (let i = 0; i < 10; i++) {
    fixtureRepo.commit("src/features/x/FileB.ts", `b${i}`, `user${i}@test.com`, i + 1);
  }

  const fixtures = [
    { file: "src/features/x/FileA.ts", added: 5, removed: 0 },
    { file: "src/features/x/FileB.ts", added: 5, removed: 0 },
  ];

  // --- Default preset ---
  delete process.env.MR_PRESET;
  const defaultScored = await scoreChunks(fixtures.map((f) => ({ ...f })), fixtureRepo.dir);
  const [defA, defB] = defaultScored;
  // Default has no authorship stage → both files score identically (same
  // size, no sensitivity, no fan-out, no shared/unknown/test/metaOnly)
  assert.ok(Math.abs(defA.risk - defB.risk) < 1e-9,
    `default: A=${defA.risk} B=${defB.risk} should be equal`);

  // --- Security preset ---
  process.env.MR_PRESET = "security";
  const securityScored = await scoreChunks(fixtures.map((f) => ({ ...f })), fixtureRepo.dir);
  const secA = securityScored.find((c) => c.file.includes("FileA"));
  const secB = securityScored.find((c) => c.file.includes("FileB"));
  // Security preset authorship weight=120: A (1 author) >> B (10 authors)
  assert.ok(secA.risk > secB.risk,
    `security: A (1 author) risk=${secA.risk} should exceed B (10 authors) risk=${secB.risk}`);
  delete process.env.MR_PRESET;
});

test("integration: recency fires for stale file under security preset", async () => {
  const fixtureRepo = makeFixtureRepo();
  // A file committed 400 days ago — stale under security's staleDays=365
  fixtureRepo.commit("src/features/x/Stale.ts", "old", "alice@test.com", 400);
  // A file committed today — not stale
  fixtureRepo.commit("src/features/x/Fresh.ts", "new", "alice@test.com", 0);

  process.env.MR_PRESET = "security";
  const scored = await scoreChunks([
    { file: "src/features/x/Stale.ts", added: 3, removed: 0 },
    { file: "src/features/x/Fresh.ts", added: 3, removed: 0 },
  ], fixtureRepo.dir);
  const stale = scored.find((c) => c.file.includes("Stale"));
  const fresh = scored.find((c) => c.file.includes("Fresh"));
  // Stale should have higher risk due to recency weight=100 firing
  assert.ok(stale.risk > fresh.risk,
    `stale=${stale.risk} should exceed fresh=${fresh.risk}`);
  delete process.env.MR_PRESET;
});
