// Tests for risk.mjs — classification (SHARED_RE/TEST_RE), scoring, ordering.
// scoreChunks greps the repo only for shared non-test files; we use a temp empty
// dir so fan-out resolves to 0 and the test stays hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreChunks, riskOrder, orderChunks, SHARED_RE, TEST_RE } from "../src/risk.mjs";

const EMPTY_REPO = mkdtempSync(join(tmpdir(), "mrp-risk-"));

test("SHARED_RE matches top-level shared dirs only", () => {
  assert.ok(SHARED_RE.test("app/src/hooks/useThing.ts"));
  assert.ok(SHARED_RE.test("app/src/services/api.ts"));
  assert.ok(SHARED_RE.test("app/src/components/Button.tsx"));
  // feature-local dirs named components/hooks are NOT shared
  assert.ok(!SHARED_RE.test("app/src/features/x/components/Local.tsx"));
  assert.ok(!SHARED_RE.test("app/src/features/x/hooks/useLocal.ts"));
});

test("TEST_RE matches .test/.spec files", () => {
  assert.ok(TEST_RE.test("a.test.ts"));
  assert.ok(TEST_RE.test("a.spec.tsx"));
  assert.ok(TEST_RE.test("a.test.jsx"));
  assert.ok(!TEST_RE.test("a.ts"));
});

test("scoreChunks classifies and scores a leaf file", async () => {
  const chunks = [{ file: "app/src/features/x/Leaf.tsx", added: 3, removed: 1 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.shared, false);
  assert.equal(c.isTest, false);
  assert.equal(c.fanOut, 0);
  // risk = 0 (not test) + 0*10 + 0 (not shared) + min(4,100)/10 = 0.4
  assert.ok(Math.abs(c.risk - 0.4) < 1e-9);
});

test("scoreChunks sinks tests below everything (negative bias)", async () => {
  const chunks = [{ file: "app/src/util.test.ts", added: 50, removed: 50 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.isTest, true);
  assert.ok(c.risk < -900);
});

test("scoreChunks marks shared files (fan-out unmeasurable in empty repo → unknown)", async () => {
  const chunks = [{ file: "app/src/hooks/useThing.ts", added: 1, removed: 0 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.shared, true);
  assert.equal(c.fanOut, 0);
  // Empty repo has no app/src → rg errors → we could NOT assess reach → unknown.
  assert.equal(c.unknown, true);
});

test("riskOrder sorts highest risk first, stable by file+pos", () => {
  const chunks = [
    { file: "b.ts", newStart: 1, risk: 10 },
    { file: "a.ts", newStart: 5, risk: 100 },
    { file: "a.ts", newStart: 1, risk: 100 },
    { file: "c.ts", newStart: 1, risk: -1000 },
  ];
  const ordered = riskOrder(chunks);
  assert.deepEqual(
    ordered.map((c) => `${c.file}:${c.newStart}`),
    ["a.ts:1", "a.ts:5", "b.ts:1", "c.ts:1"],
  );
});

test("riskOrder does not mutate its input", () => {
  const chunks = [{ file: "a", newStart: 1, risk: 1 }, { file: "b", newStart: 1, risk: 2 }];
  const snapshot = [...chunks];
  riskOrder(chunks);
  assert.deepEqual(chunks, snapshot);
});

test("sensitivity overlay: a sensitive LEAF outranks a mundane high-fan-out shared file", async () => {
  // The core threat-model claim: consequence beats reach. An auth leaf (fan-out 0)
  // must sort above a widely-imported-but-mundane shared file.
  const chunks = [
    { file: "app/src/features/checkout/auth/verify.ts", added: 2, removed: 0 }, // sensitive leaf
    { file: "app/src/hooks/useThing.ts", added: 2, removed: 0 }, // shared, fan-out 0 in empty repo
  ];
  const scored = await scoreChunks(chunks, EMPTY_REPO);
  const ordered = riskOrder(scored);
  assert.match(ordered[0].file, /auth/);
  assert.ok(ordered[0].sensLabels.includes("auth"));
  assert.ok(ordered[0].risk > ordered[1].risk);
});

test("sensitivity annotations are attached to chunks", async () => {
  const [c] = await scoreChunks(
    [{ file: "app/src/services/payment/charge.ts", added: 1, removed: 0 }],
    EMPTY_REPO,
  );
  assert.ok(c.sensitivity > 0);
  assert.ok(c.sensLabels.includes("money"));
});

test("unknown fires for a shared file whose blast radius can't be measured", async () => {
  // EMPTY_REPO has no app/src tree, so the fan-out grep errors (not "0 matches").
  // A shared file there is unassessable → unknown:true → fail-loud nudge applied.
  const [c] = await scoreChunks(
    [{ file: "app/src/services/api.ts", added: 1, removed: 0 }],
    EMPTY_REPO,
  );
  assert.equal(c.shared, true);
  assert.equal(c.unknown, true);
  // risk includes the +75 unknown nudge + 50 shared + size
  assert.ok(c.risk >= 75 + 50);
});

test("an unknown shared file outranks a plain leaf of equal size", async () => {
  const scored = await scoreChunks(
    [
      { file: "app/src/features/x/Leaf.tsx", added: 1, removed: 0 }, // plain leaf, not shared
      { file: "app/src/services/api.ts", added: 1, removed: 0 }, // shared + unknown in empty repo
    ],
    EMPTY_REPO,
  );
  const ordered = riskOrder(scored);
  assert.match(ordered[0].file, /services\/api/);
  assert.equal(ordered[0].unknown, true);
});

test("orderChunks risk mode preserves input (flat) order", () => {
  const chunks = [
    { id: "a", file: "z.ts", newStart: 5 },
    { id: "b", file: "a.ts", newStart: 1 },
    { id: "c", file: "z.ts", newStart: 1 },
  ];
  const out = orderChunks(chunks, "risk");
  assert.deepEqual(out.map((c) => c.id), ["a", "b", "c"]); // unchanged
});

test("orderChunks file mode groups by first-occurrence file, chunks top-to-bottom", () => {
  // Risk-sorted input: z.ts hit first (riskiest), then a.ts. Within z.ts, the
  // higher-risk chunk was at line 5 but file mode must present line 1 first.
  const chunks = [
    { id: "z5", file: "z.ts", newStart: 5 },
    { id: "a1", file: "a.ts", newStart: 1 },
    { id: "z1", file: "z.ts", newStart: 1 },
  ];
  const out = orderChunks(chunks, "file");
  // z.ts group first (its riskiest chunk led), chunks by line: z1, z5; then a1.
  assert.deepEqual(out.map((c) => c.id), ["z1", "z5", "a1"]);
});

test("orderChunks file mode keeps all chunks (no loss)", () => {
  const chunks = [
    { id: "a", file: "f.ts", newStart: 1 },
    { id: "b", file: "g.ts", newStart: 1 },
    { id: "c", file: "f.ts", newStart: 9 },
  ];
  const out = orderChunks(chunks, "file");
  assert.equal(out.length, 3);
  assert.deepEqual([...out.map((c) => c.id)].sort(), ["a", "b", "c"]);
});
