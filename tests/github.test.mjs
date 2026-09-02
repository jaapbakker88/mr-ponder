// Tests for src/github.mjs pure logic: normalization and position anchoring.
// No `gh` CLI is required — only the exported pure helpers are exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalisePr, normaliseFiles, buildPosition, projectSlug } from "../src/github.mjs";

// ── normalisePr ───────────────────────────────────────────────────────────────

test("normalisePr maps title, html_url, and base/head SHAs", () => {
  const pr = {
    number: 42,
    title: "Fix the thing",
    html_url: "https://github.com/owner/repo/pull/42",
    base: { sha: "base111" },
    head: { sha: "head222" },
  };
  const detail = normalisePr(pr);
  assert.equal(detail.title, "Fix the thing");
  assert.equal(detail.web_url, "https://github.com/owner/repo/pull/42");
  assert.equal(detail.sha, "head222");
  assert.deepEqual(detail.diff_refs, {
    base_sha: "base111",
    head_sha: "head222",
    start_sha: "base111", // GitHub uses base as start_sha
  });
});

test("normalisePr returns null diff_refs when SHAs are absent", () => {
  const detail = normalisePr({ title: "X", html_url: "u" });
  assert.equal(detail.diff_refs, null);
  assert.equal(detail.sha, null);
});

test("normalisePr tolerates missing fields gracefully", () => {
  const detail = normalisePr({});
  assert.equal(detail.title, "");
  assert.equal(detail.web_url, "");
  assert.equal(detail.diff_refs, null);
});

// ── normaliseFiles ────────────────────────────────────────────────────────────

test("normaliseFiles maps filename/patch to new_path/diff", () => {
  const files = [
    {
      filename: "src/foo.ts",
      status: "modified",
      patch: "@@ -1,3 +1,4 @@\n context\n+added\n context\n context",
    },
  ];
  const changes = normaliseFiles(files);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].new_path, "src/foo.ts");
  assert.equal(changes[0].old_path, "src/foo.ts"); // no previous_filename → same
  assert.ok(changes[0].diff.includes("@@"));
  assert.equal(changes[0].new_file, false);
  assert.equal(changes[0].deleted_file, false);
  assert.equal(changes[0].renamed_file, false);
});

test("normaliseFiles sets old_path from previous_filename on renames", () => {
  const files = [
    { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", patch: "" },
  ];
  const [change] = normaliseFiles(files);
  assert.equal(change.new_path, "src/new.ts");
  assert.equal(change.old_path, "src/old.ts");
  assert.equal(change.renamed_file, true);
});

test("normaliseFiles marks added and removed files correctly", () => {
  const files = [
    { filename: "a.ts", status: "added",   patch: "@@ -0,0 +1 @@\n+new" },
    { filename: "b.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-old" },
  ];
  const [added, deleted] = normaliseFiles(files);
  assert.equal(added.new_file, true);
  assert.equal(added.deleted_file, false);
  assert.equal(deleted.new_file, false);
  assert.equal(deleted.deleted_file, true);
});

test("normaliseFiles returns empty diff for binary files (no patch field)", () => {
  const files = [{ filename: "image.png", status: "modified" }];
  const [change] = normaliseFiles(files);
  assert.equal(change.diff, "");
});

test("normaliseFiles handles an empty file list", () => {
  assert.deepEqual(normaliseFiles([]), []);
});

// ── buildPosition ─────────────────────────────────────────────────────────────

const refs = { base_sha: "base111", head_sha: "head222", start_sha: "base111" };

test("buildPosition produces a GitHub review-comment position", () => {
  const pos = buildPosition({ file: "src/foo.ts", newStart: 42 }, refs);
  assert.equal(pos.commit_id, "head222");
  assert.equal(pos.path, "src/foo.ts");
  assert.equal(pos.line, 42);
  assert.equal(pos.side, "RIGHT");
});

test("buildPosition refuses a synthetic/binary chunk (newStart falsy)", () => {
  assert.equal(buildPosition({ file: "img.png", newStart: 0 }, refs), null);
});

test("buildPosition refuses when diffRefs is null", () => {
  assert.equal(buildPosition({ file: "x.ts", newStart: 5 }, null), null);
});

test("buildPosition refuses when head_sha is missing", () => {
  assert.equal(buildPosition({ file: "x.ts", newStart: 5 }, { base_sha: "b" }), null);
});

// ── projectSlug ───────────────────────────────────────────────────────────────

test("projectSlug replaces non-word chars with underscores", () => {
  assert.equal(projectSlug("owner/repo"), "owner_repo");
  assert.equal(projectSlug("my-org/my-repo"), "my-org_my-repo");
  assert.equal(projectSlug("org/group/sub/project"), "org_group_sub_project");
});
