// Tests for promote-to-comment pure logic: position anchoring + state marking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPosition } from "../src/gitlab.mjs";
import { markNotePromoted } from "../src/store.mjs";

const refs = { base_sha: "b", head_sha: "h", start_sha: "s" };

test("buildPosition anchors at the hunk's first new-side line (A1)", () => {
  const pos = buildPosition({ file: "app/src/x.ts", newStart: 88 }, refs);
  assert.equal(pos.position_type, "text");
  assert.equal(pos.head_sha, "h");
  assert.equal(pos.base_sha, "b");
  assert.equal(pos.start_sha, "s");
  assert.equal(pos.new_path, "app/src/x.ts");
  assert.equal(pos.old_path, "app/src/x.ts");
  assert.equal(pos.new_line, 88);
});

test("buildPosition refuses a synthetic/binary chunk (no line to anchor)", () => {
  assert.equal(buildPosition({ file: "img.png", newStart: 0 }, refs), null);
});

test("buildPosition refuses when diff refs are missing", () => {
  assert.equal(buildPosition({ file: "x.ts", newStart: 5 }, null), null);
  assert.equal(buildPosition({ file: "x.ts", newStart: 5 }, { base_sha: "b" }), null);
});

test("markNotePromoted records posting metadata on the right note", () => {
  const s = { notes: { "a@1:1": [{ text: "n0", at: "t" }, { text: "n1", at: "t" }] } };
  markNotePromoted(s, "a@1:1", 1, { discussionId: "d9", headSha: "h" });
  assert.equal(s.notes["a@1:1"][0].promoted, undefined);
  assert.equal(s.notes["a@1:1"][1].promoted.discussionId, "d9");
  assert.equal(s.notes["a@1:1"][1].promoted.headSha, "h");
  assert.ok(s.notes["a@1:1"][1].promoted.at);
});

test("markNotePromoted is a no-op for a missing note/chunk", () => {
  const s = { notes: {} };
  markNotePromoted(s, "nope@0:0", 0, {}); // should not throw
  assert.deepEqual(s.notes, {});
});
