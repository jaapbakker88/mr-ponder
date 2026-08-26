// gitlab.mjs — thin async wrapper over the authenticated `glab` CLI.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const enc = (s) => encodeURIComponent(s);

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
