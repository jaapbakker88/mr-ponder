// Tests for depssort.mjs — depsOrder (pure logic) and buildIntraEdges (I/O).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depsOrder, buildIntraEdges } from "../src/depssort.mjs";

// ---- depsOrder (pure) ----

test("depsOrder: returns null when no edges (signals fallback)", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const edges = new Map([
    ["a.ts", new Set()],
    ["b.ts", new Set()],
    ["c.ts", new Set()],
  ]);
  assert.equal(depsOrder(files, edges), null);
});

test("depsOrder: simple chain A→B→C produces C, B, A", () => {
  // A imports B, B imports C. C is foundation, A is consumer.
  const files = ["A.ts", "B.ts", "C.ts"];
  const edges = new Map([
    ["A.ts", new Set(["B.ts"])],
    ["B.ts", new Set(["C.ts"])],
    ["C.ts", new Set()],
  ]);
  const order = depsOrder(files, edges);
  assert.deepEqual(order, ["C.ts", "B.ts", "A.ts"]);
});

test("depsOrder: diamond — shared dep appears first", () => {
  // Both B and C import A (shared foundation). D imports B and C.
  const files = ["A.ts", "B.ts", "C.ts", "D.ts"];
  const edges = new Map([
    ["A.ts", new Set()],
    ["B.ts", new Set(["A.ts"])],
    ["C.ts", new Set(["A.ts"])],
    ["D.ts", new Set(["B.ts", "C.ts"])],
  ]);
  const order = depsOrder(files, edges);
  assert.ok(order.indexOf("A.ts") < order.indexOf("B.ts"), "A before B");
  assert.ok(order.indexOf("A.ts") < order.indexOf("C.ts"), "A before C");
  assert.ok(order.indexOf("B.ts") < order.indexOf("D.ts"), "B before D");
  assert.ok(order.indexOf("C.ts") < order.indexOf("D.ts"), "C before D");
  assert.equal(order.length, 4);
});

test("depsOrder: test files always last regardless of edges", () => {
  const files = ["types.ts", "page.tsx", "page.test.tsx"];
  const edges = new Map([
    ["types.ts", new Set()],
    ["page.tsx", new Set(["types.ts"])],
    // test imports both — but should still be last
    ["page.test.tsx", new Set(["types.ts", "page.tsx"])],
  ]);
  const order = depsOrder(files, edges);
  assert.equal(order[order.length - 1], "page.test.tsx", "test file last");
  assert.ok(order.indexOf("types.ts") < order.indexOf("page.tsx"), "types before page");
});

test("depsOrder: cycle participants are appended in original order", () => {
  // A imports B, B imports A — cycle. C has no edges (foundation).
  const files = ["C.ts", "A.ts", "B.ts"];
  const edges = new Map([
    ["C.ts", new Set()],
    ["A.ts", new Set(["B.ts"])],
    ["B.ts", new Set(["A.ts"])],
  ]);
  const order = depsOrder(files, edges);
  // C has no deps → processed first. A and B form a cycle, appended in input order.
  assert.equal(order[0], "C.ts");
  assert.ok(order.includes("A.ts") && order.includes("B.ts"));
  assert.equal(order.length, 3);
});

test("depsOrder: preserves all files, no duplicates", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.test.ts"];
  const edges = new Map([
    ["a.ts", new Set()],
    ["b.ts", new Set(["a.ts"])],
    ["c.ts", new Set(["b.ts"])],
    ["d.test.ts", new Set(["c.ts"])],
  ]);
  const order = depsOrder(files, edges);
  assert.equal(order.length, 4);
  assert.deepEqual([...order].sort(), [...files].sort());
});

// ---- buildIntraEdges (I/O) ----

// Create a temp dir with some TypeScript files that import each other.
const tmpDir = mkdtempSync(join(tmpdir(), "mrp-depssort-"));

function writeFile(rel, content) {
  const abs = join(tmpDir, rel);
  mkdirSync(abs.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// app/src/features/x/types.ts  — no imports
writeFile(
  "app/src/features/x/types.ts",
  `export type Foo = { id: string };\n`,
);

// app/src/features/x/service.ts — imports types
writeFile(
  "app/src/features/x/service.ts",
  `import type { Foo } from '@/features/x/types';\nexport function get(): Foo { return { id: '1' }; }\n`,
);

// app/src/features/x/Page.tsx — imports service and types
writeFile(
  "app/src/features/x/Page.tsx",
  `import { get } from '@/features/x/service';\nimport type { Foo } from '@/features/x/types';\n`,
);

// app/src/features/x/Page.test.tsx — imports Page
writeFile(
  "app/src/features/x/Page.test.tsx",
  `import { Page } from '@/features/x/Page';\n`,
);

const fixtureChunks = [
  { file: "app/src/features/x/types.ts" },
  { file: "app/src/features/x/service.ts" },
  { file: "app/src/features/x/Page.tsx" },
  { file: "app/src/features/x/Page.test.tsx" },
];

test("buildIntraEdges: detects import relationships from disk", async () => {
  const edges = await buildIntraEdges(fixtureChunks, tmpDir, new Map());

  // service imports types
  assert.ok(
    edges.get("app/src/features/x/service.ts")?.has("app/src/features/x/types.ts"),
    "service → types",
  );
  // Page imports service and types
  assert.ok(
    edges.get("app/src/features/x/Page.tsx")?.has("app/src/features/x/service.ts"),
    "Page → service",
  );
  assert.ok(
    edges.get("app/src/features/x/Page.tsx")?.has("app/src/features/x/types.ts"),
    "Page → types",
  );
  // types imports nothing from MR
  assert.equal(edges.get("app/src/features/x/types.ts")?.size, 0, "types has no in-MR imports");
});

test("buildIntraEdges + depsOrder: fixture MR produces types-first order", async () => {
  const edges = await buildIntraEdges(fixtureChunks, tmpDir, new Map());
  const files = fixtureChunks.map((c) => c.file);
  const order = depsOrder(files, edges);

  assert.ok(order !== null, "should detect edges");
  const idx = (f) => order.indexOf(f);
  assert.ok(idx("app/src/features/x/types.ts") < idx("app/src/features/x/service.ts"), "types before service");
  assert.ok(idx("app/src/features/x/service.ts") < idx("app/src/features/x/Page.tsx"), "service before Page");
  assert.equal(order[order.length - 1], "app/src/features/x/Page.test.tsx", "test last");
});

test("buildIntraEdges: falls back to diff text when file not on disk", async () => {
  const chunks = [
    { file: "app/src/features/x/types.ts" },
    { file: "app/src/features/x/NewFile.ts" }, // not on disk
  ];
  const diffByFile = new Map([
    ["app/src/features/x/NewFile.ts",
      "+import type { Foo } from '@/features/x/types';\n+export const x = 1;\n"],
  ]);
  // NewFile.ts doesn't exist on disk; its imports are read from the diff.
  const edges = await buildIntraEdges(chunks, tmpDir, diffByFile);
  assert.ok(
    edges.get("app/src/features/x/NewFile.ts")?.has("app/src/features/x/types.ts"),
    "NewFile → types via diff fallback",
  );
});
