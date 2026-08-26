// Tests for risk.mjs — classification (SHARED_RE/TEST_RE), scoring, ordering.
// scoreChunks greps the repo only for shared non-test files; we use a temp empty
// dir so fan-out resolves to 0 and the test stays hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreChunks, riskOrder, orderChunks, sidebarRowIndex, computeSidebarWindow, SHARED_RE, TEST_RE } from "../src/risk.mjs";

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

test("scoreChunks sinks metadata-only renames (nothing to review)", async () => {
  const chunks = [{ file: "app/src/features/x/Moved.tsx", op: "renamed", added: 0, removed: 0 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.metaOnly, true);
  assert.ok(c.risk < -800, `expected deprioritized, got ${c.risk}`);
});

test("scoreChunks does NOT sink a rename that also edits content", async () => {
  const chunks = [{ file: "app/src/features/x/Moved.tsx", op: "renamed", added: 12, removed: 3 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.metaOnly, false);
  assert.ok(c.risk > 0, `rename-with-edits should score normally, got ${c.risk}`);
});

test("scoreChunks: a pure delete is metadata-only", async () => {
  const chunks = [{ file: "app/src/features/x/Gone.tsx", op: "deleted", added: 0, removed: 0 }];
  const [c] = await scoreChunks(chunks, EMPTY_REPO);
  assert.equal(c.metaOnly, true);
  assert.ok(c.risk < -800);
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

// ---- sidebar windowing (file-order highlight-alignment regression) ----
// Bug: in file order, header rows shared the same id as their first chunk, so the
// "where is the cursor" lookup matched the HEADER row, mis-centering the scroll
// window by one and (near boundaries) pushing the highlighted chunk off-screen —
// "it starts jumping around". Header rows now carry `headerFor` (not `chunkId`),
// so the lookup must ignore them.

// Build a file-order row list exactly like the sidebar: a headerFor row per file,
// then a chunkId row per chunk. Header.headerFor == the group's first chunk id.
function fileOrderRows(files) {
  const rows = [];
  for (const g of files) {
    rows.push({ headerFor: g.chunks[0] }); // header row — NOT selectable
    for (const id of g.chunks) rows.push({ chunkId: id });
  }
  return rows;
}

test("sidebarRowIndex lands on the chunk row, never the file header", () => {
  const rows = fileOrderRows([
    { file: "a.ts", chunks: ["a1", "a2"] },
    { file: "b.ts", chunks: ["b1"] },
  ]);
  // a1 is a file's FIRST chunk — the header above it has headerFor==="a1".
  const i = sidebarRowIndex(rows, "a1");
  assert.equal(rows[i].chunkId, "a1", "must resolve to the chunk row");
  assert.equal(rows[i].headerFor, undefined, "must NOT be the header row");
  // The header for a.ts sits at index 0; the a1 chunk row at index 1.
  assert.equal(i, 1);
});

test("sidebarRowIndex returns 0 when id is absent", () => {
  const rows = fileOrderRows([{ file: "a.ts", chunks: ["a1"] }]);
  assert.equal(sidebarRowIndex(rows, "nope"), 0);
});

test("computeSidebarWindow always contains the current row (all positions)", () => {
  // A realistic file-order list: several files, some multi-chunk.
  const files = [
    { file: "a.ts", chunks: ["a1", "a2", "a3"] },
    { file: "b.ts", chunks: ["b1"] },
    { file: "c.ts", chunks: ["c1", "c2"] },
    { file: "d.ts", chunks: ["d1"] },
    { file: "e.ts", chunks: ["e1", "e2", "e3"] },
    { file: "f.ts", chunks: ["f1"] },
  ];
  const rows = fileOrderRows(files);
  const total = rows.length;
  const allIds = rows.filter((r) => r.chunkId).map((r) => r.chunkId);
  for (const sidebarH of [4, 6, 9, 100]) {
    for (const id of allIds) {
      const cur = sidebarRowIndex(rows, id);
      const { start, end } = computeSidebarWindow(total, cur, sidebarH);
      assert.ok(
        cur >= start && cur < end,
        `cur row ${cur} (id ${id}) outside window [${start},${end}) at sidebarH=${sidebarH}`,
      );
      // And the row it points at is the chunk itself, not a header.
      assert.equal(rows[cur].chunkId, id);
    }
  }
});

test("computeSidebarWindow returns the whole list when it fits", () => {
  const w = computeSidebarWindow(10, 3, 20);
  assert.deepEqual(w, { start: 0, end: 10, above: 0, below: 0 });
});

test("computeSidebarWindow shows only ↓ at the very top, only ↑ at the bottom", () => {
  const total = 50, sidebarH = 10;
  const top = computeSidebarWindow(total, 0, sidebarH);
  assert.equal(top.above, 0, "no ↑ at the top");
  assert.ok(top.below > 0, "↓ shows at the top");
  assert.ok(0 >= top.start && 0 < top.end, "row 0 visible");

  const bot = computeSidebarWindow(total, total - 1, sidebarH);
  assert.ok(bot.above > 0, "↑ shows at the bottom");
  assert.equal(bot.below, 0, "no ↓ at the bottom");
  assert.ok(total - 1 >= bot.start && total - 1 < bot.end, "last row visible");
});
