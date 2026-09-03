// Tests for store.mjs — the pure state logic (reconcile + mutation helpers).
// These do NOT touch disk: loadState/saveState are exercised separately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, addNote, toggleSeen, addTag, addLink, linksFor, markEngaged } from "../src/store.mjs";

const fresh = () => ({
  project: "p",
  iid: 1,
  headSha: null,
  fetchedAt: null,
  reviewedChunkIds: null,
  seen: {},
  engaged: {},
  notes: {},
  tags: {},
  links: [],
});

test("reconcile on first fetch records SHA, no staleness", () => {
  const s = fresh();
  const { staleSha, orphaned } = reconcile(s, "abc", "2026-01-01", ["f@1:1"].map(id => ({ id, contentHash: "h" })));
  assert.equal(staleSha, false);
  assert.deepEqual(orphaned, []);
  assert.equal(s.headSha, "abc");
  assert.equal(s.fetchedAt, "2026-01-01");
});

test("reconcile detects a changed head SHA (force-push)", () => {
  const s = fresh();
  s.headSha = "old";
  const { staleSha } = reconcile(s, "new", "t", ["f@1:1"].map(id => ({ id, contentHash: "h" })));
  assert.equal(staleSha, true);
  assert.equal(s.headSha, "new");
});

test("reconcile reports annotated chunks absent from the new diff as orphaned", () => {
  const s = fresh();
  s.headSha = "old";
  s.notes["gone@1:1"] = [{ text: "n", at: "t" }];
  s.tags["also-gone@2:2"] = ["x"];
  s.seen["kept@3:3"] = true;
  const { orphaned } = reconcile(s, "new", "t", ["kept@3:3"].map(id => ({ id, contentHash: "h" })));
  assert.deepEqual(orphaned.sort(), ["also-gone@2:2", "gone@1:1"]);
});

test("reconcile with same SHA is not stale", () => {
  const s = fresh();
  s.headSha = "same";
  const { staleSha } = reconcile(s, "same", "t", [].map(id => ({ id, contentHash: "h" })));
  assert.equal(staleSha, false);
});

test("addNote trims and ignores empty", () => {
  const s = fresh();
  addNote(s, "c1", "  hello  ");
  addNote(s, "c1", "   ");
  addNote(s, "c1", "");
  assert.equal(s.notes["c1"].length, 1);
  assert.equal(s.notes["c1"][0].text, "hello");
  assert.ok(s.notes["c1"][0].at);
});

test("toggleSeen flips on and off", () => {
  const s = fresh();
  toggleSeen(s, "c1");
  assert.equal(s.seen["c1"], true);
  toggleSeen(s, "c1");
  assert.equal(s.seen["c1"], undefined);
});

test("addTag strips leading #, dedupes, ignores empty", () => {
  const s = fresh();
  addTag(s, "c1", "#auth");
  addTag(s, "c1", "auth");
  addTag(s, "c1", "  ");
  assert.deepEqual(s.tags["c1"], ["auth"]);
});

test("addLink dedupes and rejects self-links", () => {
  const s = fresh();
  addLink(s, "a", "b", "rel");
  addLink(s, "a", "b", "dup");
  addLink(s, "a", "a", "self");
  assert.equal(s.links.length, 1);
  assert.equal(s.links[0].label, "rel");
});

test("linksFor returns links touching a chunk in either direction", () => {
  const s = fresh();
  addLink(s, "a", "b");
  addLink(s, "c", "a");
  addLink(s, "x", "y");
  const forA = linksFor(s, "a");
  assert.equal(forA.length, 2);
});

test("markEngaged is one-way and idempotent", () => {
  const s = fresh();
  markEngaged(s, "c1");
  markEngaged(s, "c1");
  assert.equal(s.engaged["c1"], true);
  assert.equal(Object.keys(s.engaged).length, 1);
});

test("markEngaged tolerates missing engaged map (legacy state)", () => {
  const s = fresh();
  delete s.engaged;
  markEngaged(s, "c1");
  assert.equal(s.engaged["c1"], true);
});

test("reconcile first review: no delta (nothing to compare), records reviewed set", () => {
  const s = fresh();
  const { newIds } = reconcile(s, "sha1", "t", ["a@1:1", "b@2:2"].map(id => ({ id, contentHash: "h" })));
  assert.deepEqual(newIds, []); // first pass: no prior set
  assert.deepEqual(s.reviewedChunkIds, ["a@1:1", "b@2:2"]);
});

test("reconcile re-review: newIds = chunks not present last time", () => {
  const s = fresh();
  reconcile(s, "sha1", "t1", ["a@1:1", "b@2:2"].map(id => ({ id, contentHash: "h" }))); // first pass
  const { newIds, staleSha } = reconcile(s, "sha2", "t2", ["a@1:1", "c@9:9", "d@10:10"].map(id => ({ id, contentHash: "h" })));
  assert.equal(staleSha, true);
  assert.deepEqual(newIds.sort(), ["c@9:9", "d@10:10"]); // b removed, c+d new
  assert.deepEqual(s.reviewedChunkIds, ["a@1:1", "c@9:9", "d@10:10"]); // base advances
});

test("reconcile delta base advances each pass (diffs vs previous, not original)", () => {
  const s = fresh();
  reconcile(s, "s1", "t", ["a@1:1"].map(id => ({ id, contentHash: "h" })));
  reconcile(s, "s2", "t", ["a@1:1", "b@2:2"].map(id => ({ id, contentHash: "h" }))); // b is new here
  const { newIds } = reconcile(s, "s3", "t", ["a@1:1", "b@2:2", "e@5:5"].map(id => ({ id, contentHash: "h" })));
  assert.deepEqual(newIds, ["e@5:5"]); // b no longer "new" — only e
});

test("reconcile counts engaged chunks toward orphan detection", () => {
  const s = fresh();
  s.headSha = "old";
  s.engaged["gone@1:1"] = true;
  const { orphaned } = reconcile(s, "new", "t", ["kept@2:2"].map(id => ({ id, contentHash: "h" })));
  assert.ok(orphaned.includes("gone@1:1"));
});

// ---- content-hash chunk id tests ----

function chunk(id, hash = "aabbccdd") {
  return { id, contentHash: hash };
}

test("reconcile: same id + same hash → not new", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1", "hash1")]);
  const { newIds } = reconcile(s, "sha2", "t", [chunk("a@1:1", "hash1")]);
  assert.deepEqual(newIds, []);
});

test("reconcile: same id + different hash → new + changedCount", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1", "oldhash")]);
  const { newIds, changedCount } = reconcile(s, "sha2", "t", [chunk("a@1:1", "newhash")]);
  assert.deepEqual(newIds, ["a@1:1"]);
  assert.equal(changedCount, 1);
});

test("reconcile: id absent from new diff → new (not changedCount)", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1")]);
  const { newIds, changedCount } = reconcile(s, "sha2", "t", [chunk("b@2:2")]);
  assert.ok(newIds.includes("b@2:2"));
  assert.equal(changedCount, 0); // b is genuinely new, not content-changed
});

test("reconcile: content-changed annotated chunk → orphaned", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1", "oldhash")]);
  s.notes["a@1:1"] = [{ text: "my note", at: "t" }];
  const { orphaned } = reconcile(s, "sha2", "t", [chunk("a@1:1", "newhash")]);
  assert.ok(orphaned.includes("a@1:1"), "annotated content-changed chunk should be orphaned");
});

test("reconcile: unchanged annotated chunk → not orphaned", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1", "hash1")]);
  s.notes["a@1:1"] = [{ text: "my note", at: "t" }];
  const { orphaned } = reconcile(s, "sha2", "t", [chunk("a@1:1", "hash1")]);
  assert.equal(orphaned.length, 0);
});

test("reconcile: writes reviewedChunks as id→hash map", () => {
  const s = fresh();
  reconcile(s, "sha1", "t", [chunk("a@1:1", "h1"), chunk("b@2:2", "h2")]);
  assert.deepEqual(s.reviewedChunks, { "a@1:1": "h1", "b@2:2": "h2" });
});

test("reconcile: legacy state (reviewedChunkIds only) → id-only delta, no crash", () => {
  const s = fresh();
  s.reviewedChunkIds = ["a@1:1"];  // old state: no reviewedChunks
  const { newIds, changedCount } = reconcile(s, "sha2", "t", [chunk("a@1:1", "h"), chunk("b@2:2", "h")]);
  assert.deepEqual(newIds, ["b@2:2"]); // b is new by id
  assert.equal(changedCount, 0);       // no hash comparison possible
  // After this run reviewedChunks is written
  assert.ok(s.reviewedChunks);
});

test("reconcile: no previous state → newIds empty (first review)", () => {
  const s = fresh();
  const { newIds, changedCount } = reconcile(s, "sha1", "t", [chunk("a@1:1"), chunk("b@2:2")]);
  assert.deepEqual(newIds, []);
  assert.equal(changedCount, 0);
});
