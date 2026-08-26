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
import { fetchMrDetail, fetchMrChanges, preflight } from "./src/gitlab.mjs";
import { parseChanges } from "./src/diff.mjs";
import { scoreChunks, riskOrder } from "./src/risk.mjs";
import { buildImportEdges } from "./src/suggest.mjs";
import { loadState, saveState, reconcile } from "./src/store.mjs";
import { buildExport, toMarkdown } from "./src/export.mjs";
import { writeFileSync } from "node:fs";
import App from "./src/ui.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const iid = args.find((a) => /^\d+$/.test(a));
if (!iid) {
  console.error("usage: mrp <mr-iid> [--project a/b/c] [--refetch] [--export [--format json|md] [--all] [--out PATH]]");
  process.exit(1);
}

const exportMode = flag("--export");
const exportFormat = opt("--format", "json");
const exportAll = flag("--all");
const exportOut = opt("--out", null);

const project =
  opt("--project", process.env.MR_PROJECT) ||
  "<group>/<project>";
const repoDir = process.env.MR_REPO_DIR || join(homedir(), "work", "<project>");

// A minimal stderr spinner that shows the current startup phase. Animates only
// on a TTY; on a pipe it prints one static line per phase. stop() clears the
// line so the Ink render starts on a clean terminal.
function makeSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = process.stderr.isTTY;
  let i = 0;
  let label = "";
  let timer = null;
  const draw = () => {
    process.stderr.write(`\r${frames[i = (i + 1) % frames.length]} ${label}   `);
  };
  return {
    phase(text) {
      label = text;
      if (tty) {
        if (!timer) timer = setInterval(draw, 80);
        draw();
      } else {
        process.stderr.write(`${text}…\n`);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      if (tty) process.stderr.write("\r\x1b[2K"); // clear the spinner line
    },
  };
}

async function main() {
  await preflight();
  const spin = makeSpinner();
  try {
    spin.phase("fetching MR");
    const [detail, changes] = await Promise.all([
      fetchMrDetail(project, iid),
      fetchMrChanges(project, iid),
    ]);

    spin.phase("computing blast radius");
    const chunks = riskOrder(await scoreChunks(parseChanges(changes), repoDir));
    const headSha = detail.diff_refs?.head_sha || detail.sha || null;

    // Precompute import-edges for link suggestions. Prefer the local checkout;
    // fall back to imports visible in each file's diff when the branch isn't out.
    spin.phase("mapping import edges");
    const diffByFile = new Map(
      changes.map((f) => [f.new_path || f.old_path, f.diff || ""]),
    );
    const importEdges = await buildImportEdges(chunks, repoDir, diffByFile);

    const state = loadState(project, iid);
  const { staleSha, orphaned, newIds } = reconcile(
    state,
    headSha,
    new Date().toISOString(),
    chunks.map((c) => c.id),
  );
  saveState(state);
  spin.stop();

  // Tag delta chunks so the UI can flag/filter "changed since your last review".
  const newIdSet = new Set(newIds);
  for (const c of chunks) c.isNew = newIdSet.has(c.id);

  // --export: emit a structured artifact and exit; no TUI.
  if (exportMode) {
    const ex = buildExport(state, chunks, { iid: Number(iid) }, { all: exportAll });
    const out = exportFormat === "md" ? toMarkdown(ex) : JSON.stringify(ex, null, 2);
    if (exportOut) {
      writeFileSync(exportOut, out + "\n");
      process.stderr.write(`wrote ${exportOut}\n`);
    } else {
      process.stdout.write(out + "\n");
    }
    return;
  }

  if (staleSha) {
    process.stdout.write(
      `\n⚠ this MR was updated since your last review (head SHA changed).\n` +
        `  ${orphaned.length} annotated chunk(s) no longer match the current diff.\n` +
        `  ${newIds.length} new/changed chunk(s) since last review — press 'd' to review just the delta.\n` +
        `  Your notes are preserved but may point at shifted lines.\n\n`,
    );
  }

  const uiDetail = {
    iid: Number(iid),
    project,
    title: (detail.title || "").replace(/\s+/g, " ").trim(),
    web_url: detail.web_url,
    headSha,
    diffRefs: detail.diff_refs || null,
    newCount: newIds.length,
  };

  render(
    React.createElement(App, { initialState: state, chunks, detail: uiDetail, importEdges }),
    );
  } finally {
    spin.stop(); // safety: clear the spinner even if a phase threw
  }
}

main().catch((e) => {
  console.error("mrp failed:", e.message);
  process.exit(1);
});
