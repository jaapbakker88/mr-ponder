// Tests for suggest.mjs suggestLinks — the pure ranking logic.
// buildImportEdges is I/O-bound (reads repo files) and covered separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestLinks } from "../src/suggest.mjs";

const chunk = (id, file) => ({ id, file });
const emptyState = () => ({ tags: {}, links: [] });
const noEdges = new Map();

test("returns [] for a null chunk", () => {
  assert.deepEqual(suggestLinks(null, [], emptyState(), noEdges), []);
});

test("same-file chunks are suggested (score 2)", () => {
  const a = chunk("a@1:1", "f.ts");
  const b = chunk("b@2:2", "f.ts");
  const res = suggestLinks(a, [a, b], emptyState(), noEdges);
  assert.equal(res.length, 1);
  assert.equal(res[0].chunk.id, "b@2:2");
  assert.ok(res[0].reasons.includes("same file"));
});

test("import-edge outranks same-file", () => {
  const a = chunk("a@1:1", "f.ts");
  const sameFile = chunk("b@2:2", "f.ts");
  const edged = chunk("c@1:1", "g.ts");
  const edges = new Map([["a@1:1", new Set(["c@1:1"])]]);
  const res = suggestLinks(a, [a, sameFile, edged], emptyState(), edges);
  assert.equal(res[0].chunk.id, "c@1:1"); // edge (5) > same file (2)
  assert.ok(res[0].reasons.includes("import edge"));
});

test("shared tag contributes score and a #reason", () => {
  const a = chunk("a@1:1", "f.ts");
  const b = chunk("b@1:1", "g.ts");
  const state = { tags: { "a@1:1": ["auth"], "b@1:1": ["auth"] }, links: [] };
  const res = suggestLinks(a, [a, b], state, noEdges);
  assert.equal(res[0].chunk.id, "b@1:1");
  assert.ok(res[0].reasons.some((r) => r.startsWith("#auth")));
});

test("excludes self and already-linked targets", () => {
  const a = chunk("a@1:1", "f.ts");
  const b = chunk("b@2:2", "f.ts");
  const state = { tags: {}, links: [{ from: "a@1:1", to: "b@2:2" }] };
  const res = suggestLinks(a, [a, b], state, noEdges);
  assert.equal(res.length, 0); // b already linked, a is self
});

test("respects the limit", () => {
  const a = chunk("a@1:1", "f.ts");
  const others = Array.from({ length: 10 }, (_, i) => chunk(`x${i}@1:1`, "f.ts"));
  const res = suggestLinks(a, [a, ...others], emptyState(), noEdges, 3);
  assert.equal(res.length, 3);
});
