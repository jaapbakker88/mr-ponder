// gitlab.mjs — thin async wrapper over the authenticated `glab` CLI.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const enc = (s) => encodeURIComponent(s);

// Verify the `glab` CLI is present and authenticated before we try to use it.
// Throws an Error with actionable, human-readable text (the entry point prints
// `.message` and exits). Distinguishes "not installed" from "not logged in".
export async function preflight() {
  try {
    await execFileP("glab", ["auth", "status"], { timeout: 10_000 });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        "`glab` (GitLab CLI) is not installed or not on PATH.\n" +
          "  Install it: https://gitlab.com/gitlab-org/cli — e.g. `brew install glab`.",
      );
    }
    // glab exits non-zero from `auth status` when no token is configured.
    throw new Error(
      "`glab` is installed but not authenticated.\n" +
        "  Run `glab auth login` and try again.",
    );
  }
}

export function projectSlug(project) {
  return project.replace(/[^\w.-]+/g, "_");
}

export async function api(path) {
  const { stdout } = await execFileP("glab", ["api", path], {
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// Full MR detail — carries diff_refs (base/head/start SHAs) needed later to
// anchor a promoted comment, plus title/author/web_url.
export async function fetchMrDetail(project, iid) {
  const P = enc(project);
  return api(`projects/${P}/merge_requests/${iid}`);
}

// The changed files with unified diffs (already delimited into @@ hunks).
export async function fetchMrChanges(project, iid) {
  const P = enc(project);
  const d = await api(`projects/${P}/merge_requests/${iid}/changes?per_page=100`);
  return d.changes || [];
}

// Build a GitLab diff-note "position" for a chunk (A1 coarse anchoring: attach at
// the hunk's first new-side line). Pure + testable. Returns null when the chunk
// can't carry a valid text position (synthetic/binary hunk with no real line) so
// the caller can refuse promotion instead of posting a broken anchor.
export function buildPosition(chunk, diffRefs) {
  if (!diffRefs || !diffRefs.head_sha) return null;
  if (!chunk || !chunk.newStart) return null; // synthetic/binary: no line to anchor
  return {
    position_type: "text",
    base_sha: diffRefs.base_sha,
    head_sha: diffRefs.head_sha,
    start_sha: diffRefs.start_sha,
    new_path: chunk.file,
    old_path: chunk.file,
    new_line: chunk.newStart,
  };
}

// Post a diff-note (a review discussion anchored to a line) to the MR. Returns
// the created discussion's raw JSON. Throws on failure (caller keeps the note
// un-promoted and shows the error).
export async function postDiffNote(project, iid, position, body) {
  const P = enc(project);
  const args = ["api", "--method", "POST", `projects/${P}/merge_requests/${iid}/discussions`, "-f", `body=${body}`];
  for (const [k, v] of Object.entries(position)) {
    if (v === undefined || v === null) continue;
    args.push("-f", `position[${k}]=${v}`);
  }
  const { stdout } = await execFileP("glab", args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}
