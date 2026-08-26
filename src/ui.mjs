// ui.mjs — two-pane Ink TUI for reviewing an existing MR hunk-by-hunk.
//
//   ┌────────────────────────┬──────────────────────────────────────────┐
//   │ SIDEBAR (always-on map) │ HUNK pane                                 │
//   │  file → chunks, markers │  current diff hunk + its notes/tags/links │
//   │  seen/note/link/tag     │  (or the link-suggestion list when linking)│
//   └────────────────────────┴──────────────────────────────────────────┘
//
// Written with React.createElement (aliased `h`) so it runs under plain `node`
// with no build step.
//
// Keys:
//   j/k ↓/↑    next / prev chunk (moves selection in both panes)
//   [ / ]      jump to prev / next file
//   g / G      first / last chunk
//   space      toggle "seen"
//   n          add note ($EDITOR)
//   t          add tag
//   l          link: shows ranked suggestions — press 1-9 to pick, or f to free-pick
//   / u s      filter / unseen-only / shared-only
//   ? q        help / quit   (state saves on every change)

import React, { useState, useMemo } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState, addNote, toggleSeen, addTag, addLink, linksFor } from "./store.mjs";
import { suggestLinks } from "./suggest.mjs";

const h = React.createElement;
const SIDEBAR_W = 36;

function editorPrompt(seed = "") {
  const editor = process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "mrp-"));
  const file = join(dir, "NOTE.md");
  writeFileSync(file, seed);
  const r = spawnSync(editor, [file], { stdio: "inherit" });
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch {}
  try { unlinkSync(file); } catch {}
  if (r.status !== 0 && !text) return "";
  return text.replace(/\n+$/, "");
}

function diffLineColor(line) {
  if (line.startsWith("@@")) return "cyan";
  if (line.startsWith("+")) return "green";
  if (line.startsWith("-")) return "red";
  return undefined; // context: inherit default fg (theme-safe)
}

// Compute the new-file line number for every body line of a hunk.
// - context lines: advance both old & new counters → show the new-side number
// - added (+):     advance new only → show the new number
// - removed (-):   advance old only → no new number (blank gutter)
// - the @@ header:  no number
// Returns an array of { line, num } aligned with chunk.body.
function withLineNumbers(chunk) {
  let newNo = chunk.newStart || 0;
  const out = [];
  for (const line of chunk.body) {
    if (line.startsWith("@@")) {
      out.push({ line, num: null });
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ line, num: null }); // removed line has no new-file number
    } else if (line.startsWith("+")) {
      out.push({ line, num: newNo++ });
    } else {
      out.push({ line, num: newNo++ }); // context
    }
  }
  return out;
}

// short label for a chunk row in the sidebar: line range + context snippet
function chunkLabel(c) {
  const loc = c.newStart ? `${c.newStart}` : "·";
  const ctx = (c.context || "").replace(/^(export\s+)?(async\s+)?(function|const|class)\s+/, "");
  return `${loc} ${ctx}`.trim();
}

export default function App({ initialState, chunks, detail, importEdges }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState(initialState);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState("view"); // view | tag | search | suggest
  const [buffer, setBuffer] = useState("");
  const [filter, setFilter] = useState("");
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [sharedOnly, setSharedOnly] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [linkArmed, setLinkArmed] = useState(null);
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState("");
  const [focus, setFocus] = useState("sidebar"); // sidebar | hunk
  const [scroll, setScroll] = useState(0); // hunk-body scroll offset (lines)

  const persist = (mutator) =>
    setState((prev) => {
      const next = { ...prev };
      mutator(next);
      saveState(next);
      return next;
    });

  const flashMsg = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(""), 1500);
  };

  const visible = useMemo(() => {
    let list = chunks;
    if (unseenOnly) list = list.filter((c) => !state.seen[c.id]);
    if (sharedOnly) list = list.filter((c) => c.shared);
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((c) => {
        const notes = (state.notes[c.id] || []).map((n) => n.text).join(" ");
        const tags = (state.tags[c.id] || []).join(" ");
        return (
          c.file.toLowerCase().includes(q) ||
          (c.context || "").toLowerCase().includes(q) ||
          notes.toLowerCase().includes(q) ||
          tags.toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [chunks, state, unseenOnly, sharedOnly, filter]);

  const safeIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const chunk = visible[safeIdx];

  // Sidebar model: visible chunks grouped by file, preserving risk order.
  const fileGroups = useMemo(() => {
    const groups = [];
    const byFile = new Map();
    for (const c of visible) {
      if (!byFile.has(c.file)) {
        const g = { file: c.file, chunks: [] };
        byFile.set(c.file, g);
        groups.push(g);
      }
      byFile.get(c.file).chunks.push(c);
    }
    return groups;
  }, [visible]);

  const jumpFile = (dir) => {
    if (!chunk) return;
    const fi = fileGroups.findIndex((g) => g.file === chunk.file);
    const nf = fileGroups[fi + dir];
    if (!nf) return;
    const target = nf.chunks[0];
    const gi = visible.indexOf(target);
    if (gi >= 0) setIdx(gi);
  };

  // Terminal size + how many hunk-body lines fit at once (used by scroll math
  // in the input handler AND the render below, so compute it once here).
  const cols = (stdout && stdout.columns) || 120;
  const rows = (stdout && stdout.rows) || 32;
  const paneW = Math.max(40, cols - SIDEBAR_W - 3);
  const bodyH = Math.max(6, rows - 14); // visible hunk lines
  const bodyLen = chunk ? chunk.body.length : 0;
  const maxScroll = Math.max(0, bodyLen - bodyH);

  const moveChunk = (delta) => {
    setIdx((i) => Math.min(Math.max(i + delta, 0), visible.length - 1));
    setScroll(0); // new chunk starts at the top of its diff
  };

  useInput((input, key) => {
    // Tab always toggles which pane the arrow/jk keys drive.
    if (key.tab) {
      setFocus((f) => (f === "sidebar" ? "hunk" : "sidebar"));
      return;
    }

    // text-entry modes
    if (mode === "tag" || mode === "search") {
      if (key.return) {
        if (mode === "tag" && chunk) {
          persist((s) => addTag(s, chunk.id, buffer));
          flashMsg(`tagged #${buffer.replace(/^#/, "")}`);
        }
        if (mode === "search") setFilter(buffer);
        setBuffer("");
        setMode("view");
        return;
      }
      if (key.escape) {
        setBuffer("");
        setMode("view");
        if (mode === "search") setFilter("");
        return;
      }
      if (key.backspace || key.delete) return setBuffer((b) => b.slice(0, -1));
      if (input) setBuffer((b) => b + input);
      return;
    }

    // suggestion-pick mode
    if (mode === "suggest") {
      if (key.escape) {
        setMode("view");
        setSuggestions([]);
        flashMsg("link cancelled");
        return;
      }
      if (input === "f") {
        // free-pick: leave suggest mode, arm a manual target pick
        setMode("freepick");
        flashMsg("free-pick: navigate to target, Enter to link (Esc cancels)");
        return;
      }
      const n = parseInt(input, 10);
      if (n >= 1 && n <= suggestions.length) {
        const target = suggestions[n - 1].chunk;
        const label = editorPrompt("# how are these related?\n").replace(/^#.*$/gm, "").trim();
        persist((s) => addLink(s, chunk.id, target.id, label));
        setMode("view");
        setSuggestions([]);
        flashMsg("linked");
      }
      return;
    }

    // free-pick target selection (fallback when no suggestion fits)
    if (mode === "freepick") {
      if (key.escape) {
        setMode("view");
        setLinkArmed(null);
        flashMsg("link cancelled");
        return;
      }
      if (key.return && chunk && linkArmed && chunk.id !== linkArmed) {
        const label = editorPrompt("# how are these related?\n").replace(/^#.*$/gm, "").trim();
        persist((s) => addLink(s, linkArmed, chunk.id, label));
        setMode("view");
        setLinkArmed(null);
        flashMsg("linked");
        return;
      }
      // fall through for navigation
    }

    // normal keys
    if (input === "q") return exit();
    if (input === "?") return setHelp((v) => !v);
    // j/k (and arrows) drive whichever pane has focus: sidebar = move between
    // chunks; hunk = scroll the diff body. Tab toggles focus.
    if (key.downArrow || input === "j") {
      if (focus === "hunk") setScroll((s) => Math.min(s + 1, maxScroll));
      else moveChunk(1);
    } else if (key.upArrow || input === "k") {
      if (focus === "hunk") setScroll((s) => Math.max(s - 1, 0));
      else moveChunk(-1);
    } else if (key.pageDown || (key.ctrl && input === "d")) {
      setScroll((s) => Math.min(s + bodyH, maxScroll));
    } else if (key.pageUp || (key.ctrl && input === "u")) {
      setScroll((s) => Math.max(s - bodyH, 0));
    } else if (input === "[") jumpFile(-1);
    else if (input === "]") jumpFile(1);
    else if (input === "g") { if (focus === "hunk") setScroll(0); else moveChunk(-visible.length); }
    else if (input === "G") { if (focus === "hunk") setScroll(maxScroll); else moveChunk(visible.length); }
    else if (input === " ") { if (chunk) persist((s) => toggleSeen(s, chunk.id)); }
    else if (input === "n") {
      if (chunk) {
        const text = editorPrompt(`# note on ${chunk.file}\n# ${chunk.context}\n\n`)
          .replace(/^#.*$/gm, "").trim();
        if (text) { persist((s) => addNote(s, chunk.id, text)); flashMsg("note saved"); }
      }
    } else if (input === "t") setMode("tag");
    else if (input === "/") { setMode("search"); setBuffer(""); }
    else if (input === "l") {
      if (chunk) {
        const sugg = suggestLinks(chunk, chunks, state, importEdges);
        setLinkArmed(chunk.id);
        if (sugg.length) { setSuggestions(sugg); setMode("suggest"); }
        else { setMode("freepick"); flashMsg("no suggestions — navigate to target, Enter to link"); }
      }
    }     else if (input === "u") { setUnseenOnly((v) => !v); setIdx(0); }
    else if (input === "s") { setSharedOnly((v) => !v); setIdx(0); }
  });

  const seenCount = Object.keys(state.seen).length;
  const noteCount = Object.values(state.notes).reduce((s, a) => s + a.length, 0);

  if (help) {
    return h(Box, { flexDirection: "column", padding: 1 },
      h(Text, { bold: true, color: "cyan" }, "mrp — keys"),
      h(Text, null, "  Tab        switch focus: sidebar (move chunks) ↔ hunk (scroll diff)"),
      h(Text, null, "  j/k ↓/↑    sidebar: prev/next chunk · hunk: scroll line"),
      h(Text, null, "  PgUp/PgDn  scroll hunk a page (also Ctrl+u / Ctrl+d)"),
      h(Text, null, "  [ / ]      jump prev / next file"),
      h(Text, null, "  g / G      top / bottom (of list, or of hunk when focused)"),
      h(Text, null, "  space      toggle seen"),
      h(Text, null, "  n / t      note ($EDITOR) / tag"),
      h(Text, null, "  l          link → pick a suggestion (1-9) or f to free-pick"),
      h(Text, null, "  / u s      filter / unseen-only / shared-only"),
      h(Text, null, "  ? q        help / quit"),
      h(Text, { dimColor: true }, "state saves automatically · press ? to return"));
  }

  // ---- sidebar ----
  const sidebarRows = [];
  const maxSidebar = rows - 4;
  for (const g of fileGroups) {
    if (sidebarRows.length >= maxSidebar) break;
    const short = g.file.replace(/^app\/src\//, "").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
    const anyShared = g.chunks.some((c) => c.shared);
    sidebarRows.push(
      h(Text, { key: `f-${g.file}`, bold: true, wrap: "truncate" },
        anyShared ? h(Text, { color: "magenta" }, "◆ ") : "  ",
        short.slice(0, SIDEBAR_W - 3)));
    for (const c of g.chunks) {
      if (sidebarRows.length >= maxSidebar) break;
      const isCur = chunk && c.id === chunk.id;
      const marks =
        (state.seen[c.id] ? "✓" : " ") +
        ((state.notes[c.id] || []).length ? "▸" : " ") +
        (linksFor(state, c.id).length ? "⇄" : " ") +
        ((state.tags[c.id] || []).length ? "#" : " ");
      const label = chunkLabel(c).slice(0, SIDEBAR_W - 8);
      sidebarRows.push(
        h(Text, { key: c.id, inverse: isCur, wrap: "truncate" },
          `  ${marks} `,
          h(Text, { color: c.isTest ? "blue" : undefined, dimColor: !isCur && state.seen[c.id] }, label)));
    }
  }
  const sidebar = h(Box,
    { flexDirection: "column", width: SIDEBAR_W, marginRight: 1, borderStyle: "round", borderDimColor: true, paddingX: 1 },
    h(Text, { dimColor: true }, `${visible.length} chunks · ${fileGroups.length} files`),
    ...sidebarRows);

  // ---- right pane ----
  let rightChildren;
  if (!chunk) {
    rightChildren = [
      h(Text, { key: "e", color: "yellow" }, "No chunks match the current filter."),
      h(Text, { key: "h", dimColor: true }, "u=unseen s=shared /=search (Esc clears) · q quit"),
    ];
  } else if (mode === "suggest") {
    // link suggestion list
    rightChildren = [
      h(Text, { key: "t", bold: true, color: "magenta" }, `Link from: ${chunkLabel(chunk)} `),
      h(Text, { key: "f", dimColor: true }, chunk.file),
      h(Text, { key: "sp" }, " "),
      h(Text, { key: "hd", bold: true }, "Suggested targets — press number to link, f=free-pick, Esc=cancel"),
      ...suggestions.map((s, i) =>
        h(Text, { key: s.chunk.id },
          h(Text, { color: "cyan" }, ` ${i + 1} `),
          h(Text, { color: "yellow" }, `[${s.reasons.join(", ")}] `),
          h(Text, null, `${s.chunk.file.replace(/^app\/src\//, "")} `),
          h(Text, { dimColor: true }, chunkLabel(s.chunk)))),
    ];
  } else {
    const numbered = withLineNumbers(chunk);
    const clampScroll = Math.min(scroll, maxScroll);
    const shown = numbered.slice(clampScroll, clampScroll + bodyH);
    const above = clampScroll;
    const below = numbered.length - (clampScroll + shown.length);
    // Gutter width from the largest new-file line number in this hunk.
    const maxNum = numbered.reduce((m, r) => (r.num && r.num > m ? r.num : m), 0);
    const gw = Math.max(2, String(maxNum).length);
    const notes = state.notes[chunk.id] || [];
    const tags = state.tags[chunk.id] || [];
    const links = linksFor(state, chunk.id);

    rightChildren = [
      h(Box, { key: "meta" },
        h(Text, null,
          state.seen[chunk.id] ? h(Text, { color: "green" }, "✓ ") : h(Text, { dimColor: true }, "· "),
          h(Text, { bold: true }, chunk.file.replace(/^app\/src\//, "")),
          chunk.shared ? h(Text, { color: "magenta" }, chunk.fanOut ? ` [shared ·${chunk.fanOut} imp]` : " [shared]") : null,
          chunk.isTest ? h(Text, { color: "blue" }, " [test]") : null,
          h(Text, { dimColor: true }, ` +${chunk.added}/-${chunk.removed}`),
          focus === "hunk" ? h(Text, { color: "cyan" }, "  ◂ hunk focus (j/k scroll)") : null)),
      chunk.context ? h(Text, { key: "ctx", dimColor: true }, `  ${chunk.context.slice(0, paneW - 2)}`) : null,
      h(Box, { key: "body", flexDirection: "column", borderStyle: "round", borderDimColor: focus !== "hunk", borderColor: focus === "hunk" ? "cyan" : undefined, paddingX: 1 },
        above > 0 ? h(Text, { key: "up", dimColor: true }, `  ↑ ${above} more above`) : null,
        ...shown.map((r, i) =>
          h(Text, { key: i, wrap: "truncate" },
            h(Text, { dimColor: true }, (r.num ? String(r.num) : "").padStart(gw) + " "),
            h(Text, { color: diffLineColor(r.line) }, r.line || " "))),
        below > 0 ? h(Text, { key: "dn", color: "yellow" }, `  ↓ ${below} more below${focus !== "hunk" ? " (Tab → hunk to scroll)" : ""}`) : null),
      tags.length ? h(Text, { key: "tags" }, ...tags.map((t) => h(Text, { key: t, color: "cyan" }, `#${t} `))) : null,
      ...notes.map((nt, i) => h(Text, { key: `n${i}`, color: "yellow", wrap: "truncate" }, `  ▸ ${nt.text.replace(/\n/g, " ⏎ ")}`)),
      ...links.map((l, i) => {
        const other = l.from === chunk.id ? l.to : l.from;
        const dir = l.from === chunk.id ? "→" : "←";
        return h(Text, { key: `l${i}`, color: "magenta", wrap: "truncate" }, `  ⇄ ${dir} ${other}${l.label ? ` (${l.label})` : ""}`);
      }),
    ];
  }

  const footer =
    mode === "tag" ? h(Text, { color: "cyan" }, `tag: ${buffer}▌`)
    : mode === "search" ? h(Text, { color: "cyan" }, `/${buffer}▌`)
    : mode === "freepick" ? h(Text, { color: "magenta" }, "free-pick: navigate to target, Enter=link, Esc=cancel")
    : flash ? h(Text, { color: "green" }, flash)
    : h(Text, { dimColor: true }, `Tab ${focus === "hunk" ? "→sidebar" : "→hunk"} · j/k ${focus === "hunk" ? "scroll" : "move"} · [ ] file · space seen · n note · t tag · l link · / find · ? help · q quit${filter ? `  [filter: ${filter}]` : ""}`);

  return h(Box, { flexDirection: "column" },
    h(Box, { key: "hd", justifyContent: "space-between" },
      h(Text, { key: "l" }, h(Text, { bold: true }, `!${detail.iid}`), " ", h(Text, { dimColor: true }, detail.title.slice(0, Math.max(20, cols - 40)))),
      h(Text, { key: "r", dimColor: true }, `${safeIdx + 1}/${visible.length} · seen ${seenCount}/${chunks.length} · ${noteCount} notes`)),
    h(Box, { key: "cols" },
      sidebar,
      h(Box, { flexDirection: "column", width: paneW }, ...rightChildren)),
    h(Box, { key: "ft", marginTop: 1 }, footer));
}
