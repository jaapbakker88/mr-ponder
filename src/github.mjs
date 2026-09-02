// github.mjs — thin async wrapper over the authenticated `gh` CLI (GitHub).
//
// Exports the same interface as gitlab.mjs so mrp.mjs can swap adapters:
//   preflight, api, projectSlug,
//   fetchMrDetail, fetchMrChanges,
//   buildPosition, postDiffNote
//
// Pure normalization helpers are also exported so tests can cover them without
// needing the `gh` CLI to be present.
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Verify the `gh` CLI is present and authenticated before we try to use it.
// Throws an Error with actionable, human-readable text. Distinguishes "not
// installed" from "not logged in".
export async function preflight() {
  try {
    await execFileP("gh", ["auth", "status"], { timeout: 10_000 });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        "`gh` (GitHub CLI) is not installed or not on PATH.\n" +
          "  Install it: https://cli.github.com — e.g. `brew install gh`.",
      );
    }
    // gh exits non-zero from `auth status` when no token is configured.
    throw new Error(
      "`gh` is installed but not authenticated.\n" +
        "  Run `gh auth login` and try again.",
    );
  }
}

export function projectSlug(repo) {
  return repo.replace(/[^\w.-]+/g, "_");
}

export async function api(path) {
  const { stdout } = await execFileP("gh", ["api", path], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// ── normalization helpers (pure, exported for tests) ──────────────────────────

// Map a GitHub PR response to the shape the rest of mrp expects:
//   { title, web_url, diff_refs: { base_sha, head_sha, start_sha }, sha }
//
// GitHub has no "start_sha" concept; base_sha doubles as the start anchor,
// which is correct: the diff is always base → head.
export function normalisePr(pr) {
  const base_sha = pr.base?.sha ?? null;
  const head_sha = pr.head?.sha ?? null;
  return {
    title: pr.title || "",
    web_url: pr.html_url || "",
    diff_refs: base_sha && head_sha
      ? { base_sha, head_sha, start_sha: base_sha }
      : null,
    sha: head_sha,
  };
}

// Map a GitHub PR files list to the shape mrp expects:
//   [{ new_path, old_path, diff, new_file, deleted_file, renamed_file }]
//
// The `patch` field carries the unified diff for the file. It is absent for
// binary files or for very large diffs (GitHub omits it at ~10 000 lines); in
// those cases diff is "".
export function normaliseFiles(files) {
  return files.map((f) => ({
    new_path: f.filename,
    old_path: f.previous_filename || f.filename,
    diff: f.patch || "",
    new_file: f.status === "added",
    deleted_file: f.status === "removed",
    renamed_file: f.status === "renamed",
  }));
}

// ── API calls ─────────────────────────────────────────────────────────────────

// Full PR detail — carries diff_refs (base/head SHAs) needed later to anchor a
// promoted comment, plus title/author/web_url.
export async function fetchMrDetail(repo, number) {
  const pr = await api(`repos/${repo}/pulls/${number}`);
  return normalisePr(pr);
}

// The changed files with unified diffs (already delimited into @@ hunks).
// GitHub paginates at 30 files by default; per_page=100 covers most PRs.
export async function fetchMrChanges(repo, number) {
  const files = await api(`repos/${repo}/pulls/${number}/files?per_page=100`);
  return normaliseFiles(Array.isArray(files) ? files : []);
}

// ── comment anchoring ─────────────────────────────────────────────────────────

// Build a GitHub pull-request review-comment position for a chunk (coarse
// anchoring: attach at the hunk's first new-side line). Pure + testable.
// Returns null when the chunk can't carry a valid position (synthetic/binary
// hunk with no real line) so the caller can refuse promotion instead of
// posting a malformed comment.
export function buildPosition(chunk, diffRefs) {
  if (!diffRefs || !diffRefs.head_sha) return null;
  if (!chunk || !chunk.newStart) return null; // synthetic/binary: no line to anchor
  return {
    commit_id: diffRefs.head_sha,
    path: chunk.file,
    line: chunk.newStart,
    side: "RIGHT",
  };
}

// Post a pull-request review comment anchored to a line.
// Returns the created comment's raw JSON. Throws on failure.
//
// Must use JSON body (--input), not -f form fields — `gh api -f` encodes
// everything as strings, which breaks numeric `line`. JSON serialises correctly.
export async function postDiffNote(repo, number, position, body) {
  const tmp = join(tmpdir(), `mrp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    writeFileSync(tmp, JSON.stringify({ body, ...position }));
    const { stdout } = await execFileP(
      "gh",
      [
        "api", "--method", "POST",
        `repos/${repo}/pulls/${number}/comments`,
        "-H", "Content-Type: application/json",
        "--input", tmp,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}
