#!/usr/bin/env node
// mrp — "MR ponder". git add -p, but for reviewing an existing GitLab MR:
// step through the diff hunk-by-hunk, risk-first, attaching PRIVATE notes,
// tags, and chunk-to-chunk links. Notes live locally (never posted); the walk
// is a thinking tool for connecting the dots across a big change.
//
// Usage:
//   mrp <iid>                     review MR !<iid>
//   mrp <iid> --project a/b/c     override project
//   mrp <iid> --refetch           re-pull the diff (after a force-push)
//
// Env:
//   MR_PROJECT    default project path
//   MR_REPO_DIR   local checkout used to compute import fan-out (blast radius)
//   EDITOR        editor used for notes (default: vi)

import React from "react";
import { render } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchMrDetail, fetchMrChanges } from "./src/gitlab.mjs";
import { parseChanges } from "./src/diff.mjs";
import { scoreChunks, riskOrder } from "./src/risk.mjs";
import { buildImportEdges } from "./src/suggest.mjs";
import { loadState, saveState, reconcile } from "./src/store.mjs";
import App from "./src/ui.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const iid = args.find((a) => /^\d+$/.test(a));
if (!iid) {
  console.error("usage: mrp <mr-iid> [--project a/b/c] [--refetch]");
  process.exit(1);
}

const project =
  opt("--project", process.env.MR_PROJECT) ||
  "<group>/<project>";
const repoDir = process.env.MR_REPO_DIR || join(homedir(), "work", "<project>");

async function main() {
  process.stdout.write("fetching MR + computing blast radius…\n");

  const [detail, changes] = await Promise.all([
    fetchMrDetail(project, iid),
    fetchMrChanges(project, iid),
  ]);

  const chunks = riskOrder(await scoreChunks(parseChanges(changes), repoDir));
  const headSha = detail.diff_refs?.head_sha || detail.sha || null;

  // Precompute import-edges for link suggestions. Prefer the local checkout;
  // fall back to imports visible in each file's diff when the branch isn't out.
  const diffByFile = new Map(
    changes.map((f) => [f.new_path || f.old_path, f.diff || ""]),
  );
  const importEdges = await buildImportEdges(chunks, repoDir, diffByFile);

  const state = loadState(project, iid);
  const { staleSha, orphaned } = reconcile(
    state,
    headSha,
    new Date().toISOString(),
    chunks.map((c) => c.id),
  );
  saveState(state);

  if (staleSha) {
    process.stdout.write(
      `\n⚠ this MR was updated since your last review (head SHA changed).\n` +
        `  ${orphaned.length} annotated chunk(s) no longer match the current diff.\n` +
        `  Your notes are preserved but may point at shifted lines.\n\n`,
    );
  }

  const uiDetail = {
    iid: Number(iid),
    title: (detail.title || "").replace(/\s+/g, " ").trim(),
    web_url: detail.web_url,
    headSha,
  };

  render(
    React.createElement(App, { initialState: state, chunks, detail: uiDetail, importEdges }),
  );
}

main().catch((e) => {
  console.error("mrp failed:", e.message);
  process.exit(1);
});
