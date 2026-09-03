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

test("empty diff with no op yields no hunks", () => {
  assert.equal(parseFileHunks(fileWith("")).length, 0);
  assert.equal(parseFileHunks(fileWith("   \n  ")).length, 0);
});

test("pure rename (empty diff) still surfaces as one synthetic chunk", () => {
  const f = { new_path: "app/src/b.ts", old_path: "app/src/a.ts", diff: "", renamed_file: true };
  const [h] = parseFileHunks(f);
  assert.ok(h, "rename must not vanish from the walk");
  assert.equal(h.op, "renamed");
  assert.equal(h.renamedFile, true);
  assert.equal(h.file, "app/src/b.ts");
  assert.equal(h.context, "renamed from app/src/a.ts");
  assert.equal(h.added, 0);
  assert.equal(h.removed, 0);
});

test("pure delete (empty diff) surfaces with op=deleted", () => {
  const f = { old_path: "app/src/gone.ts", diff: "", deleted_file: true };
  const [h] = parseFileHunks(f);
  assert.ok(h);
  assert.equal(h.op, "deleted");
  assert.equal(h.deletedFile, true);
  assert.equal(h.file, "app/src/gone.ts");
});

test("op is set on real hunks too (rename + content edit)", () => {
  const f = {
    new_path: "app/src/b.ts",
    old_path: "app/src/a.ts",
    renamed_file: true,
    diff: "@@ -1,1 +1,1 @@\n-a\n+b",
  };
  const [h] = parseFileHunks(f);
  assert.equal(h.op, "renamed");
  assert.equal(h.added, 1);
  assert.equal(h.removed, 1);
});

test("op is null for an ordinary modified file", () => {
  const [h] = parseFileHunks(fileWith("@@ -1,1 +1,1 @@\n-a\n+b"));
  assert.equal(h.op, null);
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

// ---- fnv1a + contentHash tests ----
import { fnv1a } from "../src/diff.mjs";

test("fnv1a: same input → same hash", () => {
  assert.equal(fnv1a("hello"), fnv1a("hello"));
});

test("fnv1a: one char change → different hash", () => {
  assert.notEqual(fnv1a("hello"), fnv1a("hellx"));
});

test("fnv1a: empty string → stable value", () => {
  assert.equal(typeof fnv1a(""), "string");
  assert.equal(fnv1a("").length, 8); // 8 hex chars
});

test("parseFileHunks attaches contentHash to every chunk", () => {
  const file = {
    new_path: "src/foo.ts",
    diff: "@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n",
  };
  const [chunk] = parseFileHunks(file);
  assert.ok(chunk.contentHash, "contentHash should be set");
  assert.equal(typeof chunk.contentHash, "string");
  assert.equal(chunk.contentHash.length, 8);
});

test("contentHash changes when body content changes", () => {
  const make = (line) => ({
    new_path: "src/foo.ts",
    diff: `@@ -1,2 +1,2 @@\n context\n-old\n+${line}\n`,
  });
  const h1 = parseFileHunks(make("alpha"))[0].contentHash;
  const h2 = parseFileHunks(make("beta"))[0].contentHash;
  assert.notEqual(h1, h2);
});

test("contentHash is stable across re-fetches with identical content", () => {
  const file = { new_path: "a.ts", diff: "@@ -1 +1 @@\n+line\n" };
  assert.equal(parseFileHunks(file)[0].contentHash, parseFileHunks(file)[0].contentHash);
});

test("contentHash normalises CRLF to LF (no spurious delta)", () => {
  const lf   = { new_path: "a.ts", diff: "@@ -1 +1 @@\n+line\n" };
  const crlf = { new_path: "a.ts", diff: "@@ -1 +1 @@\r\n+line\r\n" };
  assert.equal(parseFileHunks(lf)[0].contentHash, parseFileHunks(crlf)[0].contentHash);
});

test("synthetic chunk (no @@ header) also has contentHash", () => {
  const file = { new_path: "img.png", diff: "", new_file: true };
  const [chunk] = parseFileHunks(file);
  assert.ok(chunk.contentHash);
});
