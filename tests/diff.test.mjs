// Tests for diff.mjs — unified-diff → chunk parsing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFileHunks, parseChanges } from "../src/diff.mjs";

const fileWith = (diff, extra = {}) => ({ new_path: "app/src/x.ts", diff, ...extra });

test("parses a single @@ hunk with explicit counts", () => {
  const diff = [
    "@@ -1,3 +1,4 @@ function foo()",
    " ctx",
    "-old",
    "+new1",
    "+new2",
    " ctx2",
  ].join("\n");
  const hunks = parseFileHunks(fileWith(diff));
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.id, "app/src/x.ts@1:1");
  assert.equal(h.file, "app/src/x.ts");
  assert.equal(h.context, "function foo()");
  assert.equal(h.oldStart, 1);
  assert.equal(h.oldCount, 3);
  assert.equal(h.newStart, 1);
  assert.equal(h.newCount, 4);
  assert.equal(h.added, 2);
  assert.equal(h.removed, 1);
  // body includes the @@ header as first line
  assert.equal(h.body[0], "@@ -1,3 +1,4 @@ function foo()");
});

test("defaults missing hunk counts to 1", () => {
  const diff = "@@ -5 +5 @@\n-a\n+b";
  const [h] = parseFileHunks(fileWith(diff));
  assert.equal(h.oldCount, 1);
  assert.equal(h.newCount, 1);
  assert.equal(h.oldStart, 5);
  assert.equal(h.newStart, 5);
});

test("splits multiple hunks in one file", () => {
  const diff = [
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "@@ -10,1 +10,2 @@",
    " c",
    "+d",
  ].join("\n");
  const hunks = parseFileHunks(fileWith(diff));
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].id, "app/src/x.ts@1:1");
  assert.equal(hunks[1].id, "app/src/x.ts@10:10");
});

test("does not count +++/--- file headers as add/remove", () => {
  const diff = [
    "--- a/app/src/x.ts",
    "+++ b/app/src/x.ts",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
  ].join("\n");
  const [h] = parseFileHunks(fileWith(diff));
  assert.equal(h.added, 1);
  assert.equal(h.removed, 1);
});

test("stable id is file@oldStart:newStart", () => {
  const diff = "@@ -42,2 +50,3 @@\n ctx\n+x";
  const [h] = parseFileHunks(fileWith(diff));
  assert.equal(h.id, "app/src/x.ts@42:50");
});

test("synthetic chunk for diff with no @@ header (e.g. binary/new)", () => {
  const diff = "+line one\n+line two";
  const [h] = parseFileHunks(fileWith(diff, { new_file: true }));
  assert.equal(h.id, "app/src/x.ts@0:0");
  assert.equal(h.newFile, true);
  assert.equal(h.added, 2);
  assert.equal(h.removed, 0);
});

test("empty diff yields no hunks", () => {
  assert.equal(parseFileHunks(fileWith("")).length, 0);
  assert.equal(parseFileHunks(fileWith("   \n  ")).length, 0);
});

test("uses old_path when new_path absent (deleted file)", () => {
  const f = { old_path: "app/src/gone.ts", diff: "@@ -1,1 +0,0 @@\n-x", deleted_file: true };
  const [h] = parseFileHunks(f);
  assert.equal(h.file, "app/src/gone.ts");
  assert.equal(h.deletedFile, true);
});

test("parseChanges flattens files in order", () => {
  const changes = [
    { new_path: "a.ts", diff: "@@ -1,1 +1,1 @@\n-a\n+b" },
    { new_path: "b.ts", diff: "@@ -1,1 +1,1 @@\n-c\n+d\n@@ -5,1 +5,1 @@\n-e\n+f" },
  ];
  const chunks = parseChanges(changes);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.file), ["a.ts", "b.ts", "b.ts"]);
});
