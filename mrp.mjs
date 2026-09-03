#!/usr/bin/env node
// mrp — "MR ponder". git add -p, but for reviewing an existing MR/PR:
// step through the diff hunk-by-hunk, risk-first, attaching PRIVATE notes,
// tags, and chunk-to-chunk links. Notes live locally (never posted); the walk
// is a thinking tool for connecting the dots across a big change.
//
// Usage:
//   mrp <number>                        review MR/PR <number>
//   mrp <number> --project owner/repo   override project (or set MR_PROJECT)
//   mrp <number> --forge github|gitlab  override auto-detected forge (or set FORGE)
//   mrp <number> --refetch              re-pull the diff (after a force-push)
//
// Env:
//   MR_PROJECT    default project path (e.g. "owner/repo" for GitHub, "group/project" for GitLab)
//   MR_REPO_DIR   local checkout used to compute import fan-out (blast radius)
//   FORGE         forge backend: github or gitlab (auto-detected from git remote if unset)
//   EDITOR        editor used for notes (default: vi)

import React from "react";
import { render } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseChanges } from "./src/diff.mjs";
import { scoreChunks, riskOrder } from "./src/risk.mjs";
import { buildImportEdges } from "./src/suggest.mjs";
import { loadState, saveState, reconcile } from "./src/store.mjs";
import { buildExport, toMarkdown } from "./src/export.mjs";
import { writeFileSync } from "node:fs";
import App from "./src/ui.mjs";

const execFileP = promisify(execFile);

// Resolve which forge to use. Priority: --forge flag > FORGE env var >
// auto-detect from git remote in repoDir > default (gitlab).
async function detectForge(forgeFlag, repoDir) {
  const explicit = (forgeFlag || process.env.FORGE || "").toLowerCase();
  if (explicit === "github" || explicit === "gitlab") return explicit;
  if (repoDir) {
    try {
      const { stdout } = await execFileP(
        "git", ["remote", "get-url", "origin"],
        { cwd: repoDir, timeout: 5_000 },
      );
      if (stdout.includes("github.com")) return "github";
    } catch { /* not a git repo, no remote, or repoDir absent */ }
  }
  return "gitlab"; // backward-compat default
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

// --list-presets: print available presets and exit (no MR number required).
if (flag("--list-presets")) {
  const { listPresets } = await import("./src/pipeline.mjs");
  listPresets(process.env.MR_REPO_DIR ?? process.cwd());
  process.exit(0);
}

// --preset <name>: activate a named preset.  Write it to the env var that the
// pipeline runner already reads; this keeps scoreChunks(chunks, repoDir) unchanged.
const presetFlag = opt("--preset", null);
if (presetFlag) process.env.MR_PRESET = presetFlag;

const iid = args.find((a) => /^\d+$/.test(a));
if (!iid) {
  console.error("usage: mrp <mr-iid> [--project a/b/c] [--refetch] [--export [--format json|md] [--all] [--out PATH]]");
  process.exit(1);
}

const exportMode = flag("--export");
const exportFormat = opt("--format", "json");
const exportAll = flag("--all");
const exportOut = opt("--out", null);

const project = opt("--project", process.env.MR_PROJECT);
if (!project) {
  console.error(
    "error: no project specified.\n" +
    "  Set MR_PROJECT=owner/repo  (or pass --project owner/repo)",
  );
  process.exit(1);
}

// Optional: local checkout used to compute import fan-out (blast radius).
// When absent, blast-radius scoring falls back to imports visible in the diff.
const repoDir = process.env.MR_REPO_DIR ?? null;

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
  const forge = await detectForge(opt("--forge", null), repoDir);
  const forgeAdapter = await import(
    forge === "github" ? "./src/github.mjs" : "./src/gitlab.mjs"
  );
  const { preflight, fetchMrDetail, fetchMrChanges } = forgeAdapter;

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
    forgeName: forge,
    title: (detail.title || "").replace(/\s+/g, " ").trim(),
    web_url: detail.web_url,
    headSha,
    diffRefs: detail.diff_refs || null,
    newCount: newIds.length,
    staleSha,
    orphanedCount: orphaned.length,
  };

  // Take over the whole terminal via the alternate screen buffer (like vim/less):
  // mrp renders full-height, and on exit the prior terminal contents are restored
  // with no leftover frame in scrollback. Guarded to a TTY so piped/--export runs
  // (which return before here) and non-TTY hosts are unaffected.
  // MRP_NO_ALT=1 disables it (debug: some terminals mis-repaint tall Ink frames on
  // the alt screen).
  const altScreen = process.stdout.isTTY && !process.env.MRP_NO_ALT;
  const enterAlt = () => process.stdout.write("\x1b[?1049h\x1b[H\x1b[?25l"); // alt buffer, home, hide cursor
  const leaveAlt = () => process.stdout.write("\x1b[?25h\x1b[?1049l");       // show cursor, primary buffer
  if (altScreen) {
    enterAlt();
    // Safety nets: restore the terminal however we exit (clean quit, Ctrl-C,
    // uncaught throw). Idempotent — leaveAlt writing twice is harmless.
    process.once("exit", () => { if (altScreen) leaveAlt(); });
  }

  const app = render(
    React.createElement(App, { initialState: state, chunks, detail: uiDetail, importEdges, forge: forgeAdapter }),
    );
  try {
    await app.waitUntilExit();
  } finally {
    if (altScreen) leaveAlt();
  }
  } finally {
    spin.stop(); // safety: clear the spinner even if a phase threw
  }
}

main().catch((e) => {
  console.error("mrp failed:", e.message);
  process.exit(1);
});
