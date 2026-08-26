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

import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState, addNote, toggleSeen, addTag, addLink, linksFor, markEngaged, markNotePromoted } from "./store.mjs";
import { suggestLinks } from "./suggest.mjs";
import { orderChunks } from "./risk.mjs";
import { buildPosition, postDiffNote } from "./gitlab.mjs";

const h = React.createElement;
const SIDEBAR_W = 36;

// Marker prefix for scaffold/instruction lines seeded into the editor buffer.
// Only these are stripped from the returned text — so a user's own '#' lines
// (markdown headings, #define, shell snippets) survive in a note.
const SCAFFOLD = "#!mrp";

// Open $EDITOR on a temp file seeded with `seed`, return the user's text with
// scaffold lines (those starting with SCAFFOLD) and trailing blank lines removed.
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
  return text
    .split("\n")
    .filter((line) => !line.startsWith(SCAFFOLD))
    .join("\n")
    .replace(/\n+$/, "")
    .trim();
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
    // File-header lines (present in synthetic no-@@ chunks) aren't code — never
    // number them, and don't let them advance the line counter.
    if (line.startsWith("+++") || line.startsWith("---")) {
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

// short label for a chunk row in the sidebar: line + context, or a +/- summary
// when git emitted no context snippet (so a row is never just a bare number).
function chunkLabel(c) {
  const loc = c.newStart ? `L${c.newStart}` : "·";
  const ctx = (c.context || "").replace(/^(export\s+)?(async\s+)?(function|const|class)\s+/, "").trim();
  if (ctx) return `${loc} ${ctx}`;
  return `${loc} (+${c.added}/-${c.removed})`;
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
  const [deltaOnly, setDeltaOnly] = useState(false); // show only chunks new since last review
  const [testFilter, setTestFilter] = useState("all"); // all | hide (no tests) | only (tests only)
  const [orderMode, setOrderMode] = useState("risk"); // risk (flat priority) | file (grouped)
  const [suggestions, setSuggestions] = useState([]);
  const [linkArmed, setLinkArmed] = useState(null);
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState("");
  const [focus, setFocus] = useState("sidebar"); // sidebar | hunk
  const [scroll, setScroll] = useState(0); // hunk-body scroll offset (lines)
  const [confirmPromote, setConfirmPromote] = useState(false); // awaiting y/Esc to post
  const undoStack = React.useRef([]); // deep snapshots of state before each mutation

  const persist = (mutator) =>
    setState((prev) => {
      // Snapshot the pre-mutation state (deep) so `z` can restore it. Bounded to
      // avoid unbounded growth over a long review session.
      undoStack.current.push(structuredClone(prev));
      if (undoStack.current.length > 100) undoStack.current.shift();
      const next = structuredClone(prev);
      mutator(next);
      saveState(next);
      return next;
    });

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) { flashMsg("nothing to undo"); return; }
    setState(prev);
    saveState(prev);
    flashMsg("undone");
  };

  const flashMsg = (m) => {
    setFlash(m);
    setTimeout(() => setFlash(""), 1500);
  };

  // Promote the chunk's latest un-promoted note to a GitLab discussion (A1 coarse
  // anchoring). Async: posts, then marks the note promoted only on success.
  const promoteCurrentNote = () => {
    setConfirmPromote(false);
    const notes = (chunk && state.notes[chunk.id]) || [];
    const idx = notes.map((n) => !n.promoted).lastIndexOf(true); // newest un-promoted
    if (!chunk || idx < 0) { flashMsg("no un-promoted note here"); return; }
    const position = buildPosition(chunk, detail.diffRefs);
    if (!position) { flashMsg("can't anchor a comment to this hunk"); return; }
    flashMsg("posting…");
    postDiffNote(detail.project, detail.iid, position, notes[idx].text)
      .then((disc) => {
        persist((s) => markNotePromoted(s, chunk.id, idx, {
          discussionId: disc?.id || null,
          headSha: detail.headSha,
        }));
        flashMsg("posted to GitLab");
      })
      .catch((e) => flashMsg(`post failed: ${(e.message || "error").slice(0, 40)}`));
  };

  const visible = useMemo(() => {
    let list = chunks;
    if (unseenOnly) list = list.filter((c) => !state.engaged?.[c.id]);
    if (sharedOnly) list = list.filter((c) => c.shared);
    if (deltaOnly) list = list.filter((c) => c.isNew);
    if (testFilter === "hide") list = list.filter((c) => !c.isTest);
    else if (testFilter === "only") list = list.filter((c) => c.isTest);
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
    // CRITICAL: navigation walks `visible` in array order, and the sidebar renders
    // `visible` in the same order — they must agree or the cursor "teleports".
    // orderChunks encapsulates the risk-vs-file ordering (see risk.mjs).
    return orderChunks(list, orderMode);
  }, [chunks, state, unseenOnly, sharedOnly, deltaOnly, testFilter, filter, orderMode]);

  const safeIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const chunk = visible[safeIdx];

  // Keep the stored index in sync with what's actually rendered: when a filter
  // shrinks `visible`, `idx` can point past the end. `safeIdx` clamps it for
  // display, but navigation math (moveChunk) reads raw `idx` — so pull it back
  // in step to avoid a "dead" keypress that just re-clamps.
  useEffect(() => {
    if (idx !== safeIdx) setIdx(safeIdx);
  }, [idx, safeIdx]);

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

  // A chunk is "annotated" if it carries a note, tag, or link — the things the
  // reviewer created. }/{ hop between these to re-trace the connect-the-dots
  // trail without scrolling past everything in between.
  const isAnnotated = (c) =>
    (state.notes[c.id]?.length || 0) > 0 ||
    (state.tags[c.id]?.length || 0) > 0 ||
    linksFor(state, c.id).length > 0;

  const jumpAnnotated = (dir) => {
    if (!visible.length) return;
    const n = visible.length;
    for (let step = 1; step <= n; step++) {
      const j = (safeIdx + dir * step + n * step) % n;
      if (isAnnotated(visible[j])) {
        setIdx(j);
        setScroll(0);
        return;
      }
    }
    flashMsg("no annotated chunks");
  };

  // Terminal size + how many hunk-body lines fit at once (used by scroll math
  // in the input handler AND the render below, so compute it once here).
  const cols = (stdout && stdout.columns) || 120;
  const rows = (stdout && stdout.rows) || 32;
  const paneW = Math.max(40, cols - SIDEBAR_W - 3);
  const bodyH = Math.max(6, rows - 14); // visible hunk lines
  const bodyLen = chunk ? chunk.body.length : 0;
  const maxScroll = Math.max(0, bodyLen - bodyH);

  // Honest engagement: a chunk is "engaged" once its full body has been shown —
  // the bottom line is on screen (trivially true when the hunk fits, or after the
  // reviewer scrolls a long hunk to the end). One-way; observed, not self-reported.
  // Gated to view/hunk modes so text-entry/help/link flows don't trip it.
  const bottomVisible = chunk && Math.min(scroll, maxScroll) >= maxScroll;
  useEffect(() => {
    if (!chunk) return;
    if (mode !== "view" || help) return;
    if (!bottomVisible) return;
    if (state.engaged?.[chunk.id]) return;
    persist((s) => markEngaged(s, chunk.id));
  }, [chunk && chunk.id, bottomVisible, mode, help]);

  const moveChunk = (delta) => {
    setIdx((i) => Math.min(Math.max(i + delta, 0), visible.length - 1));
    setScroll(0); // new chunk starts at the top of its diff
  };

  useInput((input, key) => {
    // Caps-lock / accidental shift shouldn't dead-key the UI. Most shortcuts are
    // case-insensitive; route them through `lc`. The few that are case-SIGNIFICANT
    // by design (g vs G = top/bottom, P = promote) are matched on raw `input`.
    const lc = typeof input === "string" ? input.toLowerCase() : input;

    // Help modal is open: only ?, q, or Esc respond — everything else is inert
    // so the modal behaves like a real overlay, not a screen you can act behind.
    if (help) {
      if (input === "?" || key.escape) setHelp(false);
      else if (lc === "q") exit();
      return;
    }

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
        if (mode === "search") { setFilter(buffer); setIdx(0); setScroll(0); }
        setBuffer("");
        setMode("view");
        return;
      }
      if (key.escape) {
        setBuffer("");
        setMode("view");
        if (mode === "search") { setFilter(""); setIdx(0); setScroll(0); }
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
        const label = editorPrompt(`${SCAFFOLD} how are these related?\n`);
        persist((s) => addLink(s, chunk.id, target.id, label));
        setMode("view");
        setSuggestions([]);
        flashMsg("linked");
      }
      return;
    }

    // free-pick target selection (fallback when no suggestion fits). Only
    // navigation keys are honored here — pressing n/t/space/q etc. during a
    // link must NOT mutate the armed chunk or quit; they are swallowed.
    if (mode === "freepick") {
      if (key.escape) {
        setMode("view");
        setLinkArmed(null);
        flashMsg("link cancelled");
        return;
      }
      if (key.return && chunk && linkArmed && chunk.id !== linkArmed) {
        const label = editorPrompt(`${SCAFFOLD} how are these related?\n`);
        persist((s) => addLink(s, linkArmed, chunk.id, label));
        setMode("view");
        setLinkArmed(null);
        flashMsg("linked");
        return;
      }
      // Allow only movement keys through to the navigation handler below;
      // swallow anything else so it can't trigger a normal-mode action.
      const isNav =
        key.downArrow || key.upArrow || key.pageDown || key.pageUp ||
        lc === "j" || lc === "k" || input === "[" || input === "]" ||
        lc === "g" || (key.ctrl && (lc === "d" || lc === "u"));
      if (!isNav) return;
    }

    // Promote confirmation: y posts, anything else cancels.
    if (confirmPromote) {
      if (lc === "y") promoteCurrentNote();
      else { setConfirmPromote(false); flashMsg("promote cancelled"); }
      return;
    }

    // normal keys
    if (lc === "q") return exit();
    if (input === "?") return setHelp((v) => !v);
    // j/k (and arrows) drive whichever pane has focus: sidebar = move between
    // chunks; hunk = scroll the diff body. Tab toggles focus.
    if (key.downArrow || lc === "j") {
      if (focus === "hunk") setScroll((s) => Math.min(s + 1, maxScroll));
      else moveChunk(1);
    } else if (key.upArrow || lc === "k") {
      if (focus === "hunk") setScroll((s) => Math.max(s - 1, 0));
      else moveChunk(-1);
    } else if (key.pageDown || (key.ctrl && lc === "d")) {
      setScroll((s) => Math.min(s + bodyH, maxScroll));
    } else if (key.pageUp || (key.ctrl && lc === "u")) {
      setScroll((s) => Math.max(s - bodyH, 0));
    } else if (input === "[") jumpFile(-1);
    else if (input === "]") jumpFile(1);
    else if (input === "}") jumpAnnotated(1);
    else if (input === "{") jumpAnnotated(-1);
    // g/G are case-SIGNIFICANT (top vs bottom) — matched on raw input.
    else if (input === "g") { if (focus === "hunk") setScroll(0); else moveChunk(-visible.length); }
    else if (input === "G") { if (focus === "hunk") setScroll(maxScroll); else moveChunk(visible.length); }
    else if (input === " ") { if (chunk) persist((s) => toggleSeen(s, chunk.id)); }
    // P (capital, deliberate) — promote a note to a GitLab comment. Leaves the laptop.
    else if (input === "P") {
      const notes = (chunk && state.notes[chunk.id]) || [];
      if (!notes.some((n) => !n.promoted)) { flashMsg("no un-promoted note here"); }
      else if (!buildPosition(chunk, detail.diffRefs)) { flashMsg("can't anchor a comment to this hunk"); }
      else { setConfirmPromote(true); flashMsg("promote note to GitLab? y = post, any key = cancel"); }
    }
    else if (lc === "n") {
      if (chunk) {
        const text = editorPrompt(`${SCAFFOLD} note on ${chunk.file}\n${SCAFFOLD} ${chunk.context}\n\n`);
        if (text) { persist((s) => addNote(s, chunk.id, text)); flashMsg("note saved"); }
      }
    } else if (lc === "t") setMode("tag");
    else if (lc === "z") undo();
    else if (input === "/") { setMode("search"); setBuffer(""); }
    else if (lc === "l") {
      if (chunk) {
        const sugg = suggestLinks(chunk, chunks, state, importEdges);
        if (sugg.length) { setSuggestions(sugg); setMode("suggest"); }
        // Only free-pick needs a remembered source: navigation is live there, so
        // the source can't be read off the (moving) selection. Suggest mode links
        // straight from the current chunk.
        else { setLinkArmed(chunk.id); setMode("freepick"); flashMsg("no suggestions — navigate to target, Enter to link"); }
      }
    }     else if (lc === "u") { setUnseenOnly((v) => !v); setIdx(0); setScroll(0); }
    else if (lc === "s") { setSharedOnly((v) => !v); setIdx(0); setScroll(0); }
    else if (lc === "d") { setDeltaOnly((v) => !v); setIdx(0); setScroll(0); }
    // T cycles the test filter: all → hide tests → only tests → all.
    else if (lc === "e") {
      setTestFilter((m) => (m === "all" ? "hide" : m === "hide" ? "only" : "all"));
      setIdx(0); setScroll(0);
    }
    else if (lc === "o") { setOrderMode((m) => (m === "risk" ? "file" : "risk")); setIdx(0); setScroll(0); flashMsg(orderMode === "risk" ? "order: file (grouped, read in place)" : "order: risk (highest-consequence first)"); }
  });

  const seenCount = Object.keys(state.seen).length;
  const engagedCount = Object.keys(state.engaged || {}).length;
  const noteCount = Object.values(state.notes).reduce((s, a) => s + a.length, 0);
  // Honest gate: risky chunks (sensitive or shared/unknown) not yet engaged.
  const riskyUnengaged = chunks.filter(
    (c) => (c.sensLabels?.length || c.shared || c.unknown) && !state.engaged?.[c.id],
  ).length;

  // Help renders as a centered, bordered "modal" in place of the two-pane body
  // (header + footer stay visible), rather than blanking the whole screen.
  const helpModal = help
    ? h(Box, { justifyContent: "center", width: cols },
        h(Box,
          { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 2, paddingY: 1 },
          h(Text, { bold: true, color: "cyan" }, "mrp — keys"),
          h(Text, null, "  Tab        switch focus: sidebar (move chunks) ↔ hunk (scroll diff)"),
          h(Text, null, "  j/k ↓/↑    sidebar: prev/next chunk · hunk: scroll line"),
          h(Text, null, "  PgUp/PgDn  scroll hunk a page (also Ctrl+u / Ctrl+d)"),
          h(Text, null, "  [ / ]      jump prev / next file"),
          h(Text, null, "  { / }      jump prev / next annotated chunk"),
          h(Text, null, "  g / G      top / bottom (of list, or of hunk when focused)"),
          h(Text, null, "  space      ack (done); a chunk is auto-'seen' once its full body is scrolled into view"),
          h(Text, null, "  n / t      note ($EDITOR) / tag"),
          h(Text, null, "  P          promote the chunk's note to a GitLab comment (confirm y)"),
          h(Text, null, "  l          link → pick a suggestion (1-9) or f to free-pick"),
          h(Text, null, "  z          undo last note/tag/link/ack"),
          h(Text, null, "  / u s d e  filter / unseen / shared / delta(new) / tests(all→hide→only)"),
          h(Text, null, "  o          toggle order: risk (consequence-first) ↔ file (grouped, read in place)"),
          h(Text, null, "  ? q        help / quit"),
          h(Text, { dimColor: true }, "state saves automatically · press ? or Esc to return")))
    : null;

  // ---- sidebar ----
  const sidebarRows = [];
  const maxSidebar = rows - 4;
  const chunkMarks = (c) =>
    (state.seen[c.id] ? "✓" : state.engaged?.[c.id] ? "·" : " ") +
    ((state.notes[c.id] || []).length ? "▸" : " ") +
    (linksFor(state, c.id).length ? "⇄" : " ") +
    ((state.tags[c.id] || []).length ? "#" : " ");

  if (orderMode === "risk") {
    // Flat, risk-ranked list — display order === navigation order (no teleport).
    // Each row carries its own file so there's no grouping header to imply order.
    visible.forEach((c, i) => {
      if (sidebarRows.length >= maxSidebar) return;
      const isCur = chunk && c.id === chunk.id;
      const shortFile = c.file.replace(/^app\/src\//, "").replace(/^.*\/(?=[^/]+$)/, "");
      const risk = c.sensLabels?.length ? "⚠" : c.unknown ? "?" : c.shared ? "◆" : " ";
      const label = `${shortFile} ${chunkLabel(c)}`.slice(0, SIDEBAR_W - 8);
      sidebarRows.push(
        h(Text, { key: c.id, wrap: "truncate" },
          h(Text, { color: "cyan", bold: true }, isCur ? "▶" : " "),
          h(Text, { color: c.sensLabels?.length ? "red" : c.shared ? "magenta" : "gray", dimColor: !c.sensLabels?.length }, risk),
          h(Text, { inverse: isCur },
            ` ${chunkMarks(c)} `,
            h(Text, { color: c.isNew ? "green" : c.isTest ? "blue" : undefined, dimColor: !isCur && state.seen[c.id] }, label))));
    });
  } else {
    for (const g of fileGroups) {
      if (sidebarRows.length >= maxSidebar) break;
      const short = g.file.replace(/^app\/src\//, "").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
      const anyShared = g.chunks.some((c) => c.shared);
      const anySensitive = g.chunks.some((c) => c.sensLabels?.length);
      sidebarRows.push(
        h(Text, { key: `f-${g.file}`, bold: true, wrap: "truncate" },
          anySensitive ? h(Text, { color: "red" }, "⚠ ") : anyShared ? h(Text, { color: "magenta" }, "◆ ") : "  ",
          short.slice(0, SIDEBAR_W - 3)));
      g.chunks.forEach((c, ci) => {
        if (sidebarRows.length >= maxSidebar) return;
        const isCur = chunk && c.id === chunk.id;
        const isLast = ci === g.chunks.length - 1;
        const connector = isLast ? "└─" : "├─";
        const label = chunkLabel(c).slice(0, SIDEBAR_W - 11);
        sidebarRows.push(
          h(Text, { key: c.id, wrap: "truncate" },
            h(Text, { color: "cyan", bold: true }, isCur ? "▶" : " "),
            h(Text, { dimColor: true }, `${connector}`),
            h(Text, { inverse: isCur },
              ` ${chunkMarks(c)} `,
              h(Text, { color: c.isNew ? "green" : c.isTest ? "blue" : undefined, dimColor: !isCur && state.seen[c.id] }, label))));
      });
    }
  }
  const sidebar = h(Box,
    { flexDirection: "column", width: SIDEBAR_W, marginRight: 1, borderStyle: "round", borderColor: focus === "sidebar" ? "cyan" : undefined, borderDimColor: focus !== "sidebar", paddingX: 1 },
    h(Text, { bold: focus === "sidebar" }, focus === "sidebar" ? h(Text, { color: "cyan" }, "▶ MAP ") : h(Text, { dimColor: true }, "  MAP "), h(Text, { dimColor: true }, `${visible.length}ch · order:`), h(Text, { color: "yellow" }, orderMode)),
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
    const shortFile = chunk.file.replace(/^app\/src\//, "");
    const dir = shortFile.includes("/") ? shortFile.slice(0, shortFile.lastIndexOf("/") + 1) : "";
    const base = shortFile.slice(dir.length);

    // Badge row for the file card — the risk signals, read left-to-right by priority.
    const badges = [
      chunk.sensLabels?.length ? h(Text, { key: "b-sens", color: "red", bold: true }, `⚠ ${chunk.sensLabels.join("/")} `) : null,
      chunk.isNew ? h(Text, { key: "b-new", color: "green", bold: true }, "[new] ") : null,
      chunk.unknown ? h(Text, { key: "b-unk", color: "yellow" }, "[unassessed] ") : null,
      chunk.shared ? h(Text, { key: "b-sh", color: "magenta" }, chunk.fanOut ? `[shared ·${chunk.fanOut} imp] ` : "[shared] ") : null,
      chunk.isTest ? h(Text, { key: "b-test", color: "blue" }, "[test] ") : null,
    ].filter(Boolean);

    const hunkTitle = `${chunk.newStart ? `L${chunk.newStart}` : "·"}${chunk.context ? ` ${chunk.context}` : ""}`;

    rightChildren = [
      // ---- file card: a bounded header unit above the diff ----
      h(Box, { key: "card", flexDirection: "column", borderStyle: "round", borderColor: "gray", borderDimColor: true, paddingX: 1 },
        h(Text, { key: "path", wrap: "truncate" },
          state.seen[chunk.id] ? h(Text, { color: "green" }, "✓ ") : state.engaged?.[chunk.id] ? h(Text, { dimColor: true }, "· ") : h(Text, { dimColor: true }, "  "),
          dir ? h(Text, { dimColor: true }, dir) : null,
          h(Text, { bold: true }, base),
          h(Text, { dimColor: true }, `  +${chunk.added}/-${chunk.removed}`)),
        badges.length ? h(Box, { key: "badges" }, ...badges) : null),
      // ---- the connector line: sidebar selection → this hunk (obviously linked) ----
      h(Text, { key: "conn", wrap: "truncate" },
        h(Text, { dimColor: true }, " └▶ "),
        h(Text, { color: "cyan", bold: true }, hunkTitle.slice(0, paneW - 5))),
      // ---- diff body ----
      h(Box, { key: "body", flexDirection: "column", borderStyle: "round", borderDimColor: focus !== "hunk", borderColor: focus === "hunk" ? "cyan" : undefined, paddingX: 1 },
        above > 0 ? h(Text, { key: "up", dimColor: true }, `  ↑ ${above} more above`) : null,
        ...shown.map((r, i) => {
          const c0 = r.line[0];
          const numColor = c0 === "+" ? "green" : c0 === "-" ? "red" : undefined;
          return h(Text, { key: i, wrap: "truncate" },
            h(Text, { color: numColor, dimColor: !numColor }, (r.num ? String(r.num) : "").padStart(gw) + " "),
            h(Text, { color: diffLineColor(r.line) }, r.line || " "));
        }),
        below > 0 ? h(Text, { key: "dn", color: "yellow" }, `  ↓ ${below} more below${focus !== "hunk" ? " (Tab → hunk to scroll)" : ""}`) : null),
      tags.length ? h(Text, { key: "tags" }, ...tags.map((t) => h(Text, { key: t, color: "cyan" }, `#${t} `))) : null,
      ...notes.map((nt, i) => h(Text, { key: `n${i}`, color: "yellow", wrap: "truncate" }, `  ${nt.promoted ? "▲" : "▸"} ${nt.text.replace(/\n/g, " ⏎ ")}${nt.promoted ? " (posted)" : ""}`)),
      ...links.map((l, i) => {
        const other = l.from === chunk.id ? l.to : l.from;
        const arrow = l.from === chunk.id ? "→" : "←";
        return h(Text, { key: `l${i}`, color: "magenta", wrap: "truncate" }, `  ⇄ ${arrow} ${other}${l.label ? ` (${l.label})` : ""}`);
      }),
    ];
  }

  // Footer shows only the keys valid right now (lazygit-style), driven by
  // mode and — in view mode — the focused pane.
  const viewKeys =
    focus === "hunk"
      ? "j/k scroll · PgUp/PgDn page · g/G top/bottom · Tab →sidebar · space seen · n note · t tag · l link · z undo · ? help · q quit"
      : "j/k move · [ ] file · } { annot · space ack · n note · P post · t tag · l link · z undo · / find · u/s/d/e filter · o order · ? help · q quit";
  const activeFilters = [
    unseenOnly && "unseen",
    sharedOnly && "shared",
    deltaOnly && "delta",
    testFilter !== "all" && `tests:${testFilter}`,
    filter && `/${filter}`,
  ].filter(Boolean);
  const footer =
    confirmPromote ? h(Text, { color: "yellow", bold: true }, "post this note to GitLab as a comment?  y = post · any other key = cancel")
    : mode === "tag" ? h(Text, { color: "cyan" }, `tag: ${buffer}▌  (Enter=save, Esc=cancel)`)
    : mode === "search" ? h(Text, { color: "cyan" }, `/${buffer}▌  (Enter=apply, Esc=clear)`)
    : mode === "suggest" ? h(Text, { color: "magenta" }, "pick: 1-9=link · f=free-pick · Esc=cancel")
    : mode === "freepick" ? h(Text, { color: "magenta" }, "free-pick: navigate to target, Enter=link, Esc=cancel")
    : flash ? h(Text, { color: "green" }, flash)
    : h(Text, { dimColor: true }, `${viewKeys}${activeFilters.length ? `  [${activeFilters.join(" ")}]` : ""}`);

  return h(Box, { flexDirection: "column" },
    h(Box, { key: "hd", justifyContent: "space-between" },
      h(Text, { key: "l" },
        h(Text, { color: "magenta", bold: true }, "▚▞ mrp"),
        h(Text, { dimColor: true }, " · "),
        h(Text, { bold: true }, `!${detail.iid}`), " ",
        h(Text, { dimColor: true }, detail.title.slice(0, Math.max(16, cols - 52)))),
      h(Text, { key: "r", dimColor: true }, `${safeIdx + 1}/${visible.length} · ackd ${seenCount} · seen ${engagedCount}/${chunks.length}${riskyUnengaged ? ` · ⚠ ${riskyUnengaged} risky unseen` : ""} · ${noteCount} notes`)),
    help
      ? h(Box, { key: "cols" }, helpModal)
      : h(Box, { key: "cols" },
          sidebar,
          h(Box, { flexDirection: "column", width: paneW }, ...rightChildren)),
    h(Box, { key: "ft", marginTop: 1 }, footer));
}
