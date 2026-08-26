// Tests for paths.mjs — the shared classification + module-spec helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importSpec, SHARED_RE, TEST_RE } from "../src/paths.mjs";

test("importSpec maps app/src paths to @/ specs, dropping ext + /index", () => {
  assert.equal(importSpec("app/src/services/utils.ts"), "@/services/utils");
  assert.equal(importSpec("app/src/components/Button.tsx"), "@/components/Button");
  assert.equal(importSpec("app/src/hooks/index.ts"), "@/hooks");
  assert.equal(importSpec("src/lib/thing.js"), "@/lib/thing");
});

test("importSpec returns null for paths outside app/src or src", () => {
  assert.equal(importSpec("packages/other/x.ts"), null);
  assert.equal(importSpec("README.md"), null);
});

test("SHARED_RE and TEST_RE are exported here as the single source", () => {
  assert.ok(SHARED_RE.test("app/src/hooks/useThing.ts"));
  assert.ok(TEST_RE.test("x.spec.ts"));
});
