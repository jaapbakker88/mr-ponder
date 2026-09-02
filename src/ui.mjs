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
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveState, addNote, toggleSeen, addTag, addLink, linksFor, markEngaged, markNotePromoted, tagName, tagRange } from "./store.mjs";
import { suggestLinks } from "./suggest.mjs";
import { orderChunks, riskGlyph, riskColor, sidebarRowIndex, computeSidebarWindow } from "./risk.mjs";

const h = React.createElement;
// Sidebar width scales with the terminal so file names get more room on wide
// screens, clamped so it never starves the hunk pane (narrow) or wastes space
// (ultra-wide). Actual width computed per-render from `cols` as `sidebarW`.
const SIDEBAR_MIN = 34;
const SIDEBAR_MAX = 52;

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
// Lines eligible for pattern matching: added + context only, never the @@
// header (body[0]) or removed lines.
function patternEligibleLines(chunk) {
  return chunk.body.slice(1).filter((l) => !l.startsWith("-"));
}

// Compile a user pattern to a tester. Tries regex first (case-insensitive);
// falls back to literal substring if the source isn't valid regex.
// Returns { test: (line) => bool, reG: RegExp (global), isLiteral: bool }.
function compilePattern(raw) {
  try {
    const re = new RegExp(raw, "i");
    return { test: (s) => re.test(s), reG: new RegExp(raw, "gi"), isLiteral: false };
  } catch {
    const needle = raw.toLowerCase();
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return {
      test: (s) => s.toLowerCase().includes(needle),
      reG: new RegExp(escaped, "gi"),
      isLiteral: true,
    };
  }
}

// Extract identifiers from a chunk that also appear in at least one other chunk.
// Two signals:
//   B — chunk.context (@@ header): the enclosing function/class/type name.
//       Any declaration pattern, min 6 chars.
//   A — exported declarations in added (+) code lines only, skipping comments.
//       Requiring `export` means the symbol is reachable from other files.
// Only identifiers that appear in ≥1 other chunk survive (nothing to follow otherwise).
const DECL_RE = /(?:export\s+(?:default\s+)?)?(?:const|let|var|function\*?|async\s+function\*?|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]+)/g;
const EXPORT_DECL_RE = /export\s+(?:default\s+)?(?:const|let|var|function\*?|async\s+function\*?|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]+)/g;
// Generic names that pass other filters but aren't useful search threads.
const ID_STOP = new Set(["default", "render", "children", "handler", "callback", "undefined", "toString", "prototype", "constructor"]);
function extractIdCandidates(chunk, allChunks, limit = 9) {
  const myIds = new Set();
  const add = (id) => { if (id.length >= 6 && !ID_STOP.has(id)) myIds.add(id); };

  // B: chunk.context — one high-confidence candidate per chunk.
  if (chunk.context) {
    DECL_RE.lastIndex = 0;
    const m = DECL_RE.exec(chunk.context);
    if (m) add(m[1]);
  }

  // A: exported declarations in added lines only; skip comment lines.
  const addedCode = chunk.body.slice(1)
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(1))
    .filter((l) => { const t = l.trimStart(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("#"); });
  for (const line of addedCode) {
    EXPORT_DECL_RE.lastIndex = 0;
    for (const m of line.matchAll(EXPORT_DECL_RE)) add(m[1]);
  }

  if (!myIds.size) return [];

  // Cross-reference: count other chunks that mention each id.
  const counts = new Map();
  for (const other of allChunks) {
    if (other.id === chunk.id) continue;
    const otherLines = patternEligibleLines(other);
    for (const id of myIds) {
      const re = new RegExp(`\\b${id}\\b`);
      if (otherLines.some((l) => re.test(l))) counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]))
    .slice(0, limit)
    .map(([id, count]) => ({ id, count }));
}

// Split a line string into plain/matched segments for in-hunk highlighting.
// Returns [{ text, matched }, ...]. Always at least one segment.
// Only call when a pattern is active; compiled must have a .reG global regex.
function highlightSegments(line, compiled) {
  const segments = [];
  let lastIdx = 0;
  for (const m of line.matchAll(compiled.reG)) {
    if (m[0].length === 0) continue; // skip zero-width matches
    if (m.index > lastIdx) segments.push({ text: line.slice(lastIdx, m.index), matched: false });
    segments.push({ text: m[0], matched: true });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < line.length) segments.push({ text: line.slice(lastIdx), matched: false });
  if (!segments.length) segments.push({ text: line, matched: false });
  return segments;
}

function chunkLabel(c) {
  const loc = c.newStart ? `L${c.newStart}` : "·";
  // Metadata-only moves (pure rename/delete/add) have no useful line/context —
  // show a compact operation tag instead of a bare "·".
  if (c.metaOnly || (c.op && !c.added && !c.removed)) {
    const tag = { renamed: "renamed", deleted: "deleted", added: "added" }[c.op] || c.op;
    return tag;
  }
  const opPrefix = c.op ? `${{ renamed: "R", deleted: "D", added: "A" }[c.op] || "?"} ` : "";
  const ctx = (c.context || "").replace(/^(export\s+)?(async\s+)?(function|const|class)\s+/, "").trim();
  if (ctx) return `${opPrefix}${loc} ${ctx}`;
  return `${opPrefix}${loc} (+${c.added}/-${c.removed})`;
}

// " L12" for a single line, " L12-18" for a span, "" when chunk-level. Shared by
// the note/tag/link renderers so a line-anchored annotation shows its span.
function fmtRange(r) {
  if (!r) return "";
  return r.start === r.end ? ` L${r.start}` : ` L${r.start}-${r.end}`;
}

export default function App({ initialState, chunks, detail, importEdges, forge }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState(initialState);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState("view"); // view | tag | search | suggest | ident | freepick
  const [buffer, setBuffer] = useState("");
  const [filter, setFilter] = useState("");
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [sharedOnly, setSharedOnly] = useState(false);
  const [deltaOnly, setDeltaOnly] = useState(false); // show only chunks new since last review
  const [testFilter, setTestFilter] = useState("all"); // all | hide (no tests) | only (tests only)
  const [orderMode, setOrderMode] = useState("risk"); // risk (flat priority) | file (grouped)
  const [pattern, setPattern] = useState(""); // regex/substring over hunk bodies (`\` filter)
  const [suggestions, setSuggestions] = useState([]);
  const [identCandidates, setIdentCandidates] = useState([]); // * identifier picker
  const [linkArmed, setLinkArmed] = useState(null);
  const [help, setHelp] = useState(false);
  const [importersOpen, setImportersOpen] = useState(false); // importer-locations overlay
  const [flash, setFlash] = useState("");
  const [focus, setFocus] = useState("sidebar"); // sidebar | hunk
  const [scroll, setScroll] = useState(0); // hunk-body scroll offset (lines)
  const [lineCur, setLineCur] = useState(0); // cursor line within the hunk body (index into numbered[])
  const [selAnchor, setSelAnchor] = useState(null); // visual-select start index, or null
  const [pendingRange, setPendingRange] = useState(null); // range captured when a tag/link flow began
  const [confirmPromote, setConfirmPromote] = useState(false); // awaiting y/Esc to post
  const undoStack = React.useRef([]); // deep snapshots of state before each mutation
  const orderAnchor = React.useRef(null); // chunk id to re-find after an order toggle
  const [warnDismissed, setWarnDismissed] = useState(false); // stale-SHA badge dismissed
  const [warnOverlay, setWarnOverlay] = useState(false);     // stale-SHA overlay open

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

  // True while the stale-SHA badge should be visible (MR updated, not yet dismissed).
  const warnActive = !!(detail.staleSha && !warnDismissed);

  // Promote the chunk's latest un-promoted note to a remote review comment (A1
  // coarse anchoring). Async: posts, then marks the note promoted only on success.
  const promoteCurrentNote = () => {
    setConfirmPromote(false);
    const notes = (chunk && state.notes[chunk.id]) || [];
    const idx = notes.map((n) => !n.promoted).lastIndexOf(true); // newest un-promoted
    if (!chunk || idx < 0) { flashMsg("no un-promoted note here"); return; }
    const position = forge.buildPosition(chunk, detail.diffRefs);
    if (!position) { flashMsg("can't anchor a comment to this hunk"); return; }
    // Use the note's own line anchor when present — chunk.newStart is just the
    // hunk's first line, not where the reviewer actually put the note.
    const noteLine = notes[idx].range?.start;
    if (noteLine) position.new_line = noteLine;
    flashMsg("posting…");
    forge.postDiffNote(detail.project, detail.iid, position, notes[idx].text)
      .then((disc) => {
        persist((s) => markNotePromoted(s, chunk.id, idx, {
          discussionId: disc?.id || null,
          headSha: detail.headSha,
        }));
        const target = detail.forgeName === "github" ? "GitHub" : "GitLab";
        flashMsg(`posted to ${target}`);
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
        const tags = (state.tags[c.id] || []).map(tagName).join(" ");
        return (
          c.file.toLowerCase().includes(q) ||
          (c.context || "").toLowerCase().includes(q) ||
          notes.toLowerCase().includes(q) ||
          tags.toLowerCase().includes(q) ||
          patternEligibleLines(c).some((l) => l.toLowerCase().includes(q))
        );
      });
    }
    if (pattern) {
      const p = compilePattern(pattern);
      list = list.filter((c) => patternEligibleLines(c).some((l) => p.test(l)));
    }
    // CRITICAL: navigation walks `visible` in array order, and the sidebar renders
    // `visible` in the same order — they must agree or the cursor "teleports".
    // orderChunks encapsulates the risk-vs-file ordering (see risk.mjs).
    return orderChunks(list, orderMode);
  }, [chunks, state, unseenOnly, sharedOnly, deltaOnly, testFilter, filter, orderMode, pattern]);

  const safeIdx = Math.min(idx, Math.max(0, visible.length - 1));
  const chunk = visible[safeIdx];

  // Keep the stored index in sync with what's actually rendered: when a filter
  // shrinks `visible`, `idx` can point past the end. `safeIdx` clamps it for
  // display, but navigation math (moveChunk) reads raw `idx` — so pull it back
  // in step to avoid a "dead" keypress that just re-clamps.
  useEffect(() => {
    if (idx !== safeIdx) setIdx(safeIdx);
  }, [idx, safeIdx]);

  // After a sort-order toggle, restore the cursor to the chunk that was focused
  // before the reorder — anchor on identity (chunk.id), not on index, since the
  // index is exactly what changes. orderAnchor.current is stashed by the `o`
  // handler just before flipping orderMode (async state update), so this effect
  // always runs against the freshly-reordered visible array with a valid id or
  // skips immediately. Reuses the findIndex-by-id pattern from jumpFile.
  useEffect(() => {
    if (orderAnchor.current == null) return;
    const target = visible.findIndex((c) => c.id === orderAnchor.current);
    orderAnchor.current = null; // consume — one-shot per toggle
    if (target < 0) return; // anchored chunk filtered out — safeIdx clamp handles it
    setIdx(target);
    setScroll(0);
  }, [orderMode, visible]);

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

  // Terminal size. Re-read live on every render AND subscribe to 'resize' so a
  // stale size at mount (e.g. the alt-screen switch not settled, or a pty that
  // reports the wrong rows initially) self-corrects — otherwise the sidebar can
  // render far more rows than the terminal has and Ink repaints garbage
  // ("jumping around"). `sizeTick` forces a re-render when the terminal resizes.
  const [, setSizeTick] = useState(0);
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    const onResize = () => setSizeTick((n) => n + 1);
    stdout.on("resize", onResize);
    return () => stdout.off?.("resize", onResize);
  }, [stdout]);
  const cols = (stdout && stdout.columns) || 120;
  const rows = (stdout && stdout.rows) || 32;
  // Render ONE line short of the terminal height (see the return below): Ink's
  // trailing newline would otherwise force a scroll and desync repaints on tall
  // frames. All height budgets derive from `appH`, not raw `rows`.
  const appH = Math.max(4, rows - 1);
  // ~42% of the terminal for the map, clamped — wide enough to read file paths,
  // never so wide it crowds the diff.
  const sidebarW = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.floor(cols * 0.36)));
  // Usable text columns INSIDE the sidebar box: minus 2 border + 2 padding, then a
  // 1-col safety margin so a row can never reach the exact wrap threshold (a
  // full-width row wraps to a 2nd line on some terminals and desyncs every row
  // below it — the header/chunk misalignment seen on WezTerm). Every sidebar
  // slice is measured against this, never against sidebarW directly.
  const sidebarInner = Math.max(8, sidebarW - 5);
  const paneW = Math.max(40, cols - sidebarW - 3);
  const bodyH = Math.max(6, appH - 13); // visible hunk lines
  const bodyLen = chunk ? chunk.body.length : 0;
  const maxScroll = Math.max(0, bodyLen - bodyH);

  // The hunk body with per-line new-file numbers — computed once here because the
  // input handler (range math) and the render (highlight) both need it.
  const numbered = useMemo(() => (chunk ? withLineNumbers(chunk) : []), [chunk && chunk.id]);

  // Translate a body-index span [a,b] into a new-file line range { start, end }.
  // Lines without a new-file number (removed lines, @@ header) are skipped; if the
  // span covers only such lines we fall back to null (→ chunk-level annotation).
  const rangeFromSel = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const nums = numbered.slice(lo, hi + 1).map((r) => r.num).filter((n) => n != null);
    if (!nums.length) return null;
    return { start: Math.min(...nums), end: Math.max(...nums) };
  };

  // The range to attach to a new annotation:
  //   • a visual selection when one is armed (`v`) → its full span;
  //   • otherwise, when the hunk pane is focused, the cursor's single line so a
  //     plain `n`/`t`/`l` while reading still records WHERE it applies;
  //   • sidebar focus → null (chunk-level — the note isn't tied to one line).
  const activeRange = () => {
    if (focus !== "hunk") return null;
    if (selAnchor != null) return rangeFromSel(selAnchor, lineCur);
    return rangeFromSel(lineCur, lineCur);
  };
  const clearSel = () => setSelAnchor(null);

  // Honest engagement: a chunk is "engaged" once its full body has been shown —
  // the bottom line is on screen (trivially true when the hunk fits, or after the
  // reviewer scrolls a long hunk to the end). One-way; observed, not self-reported.
  // Gated to view/hunk modes so text-entry/help/link flows don't trip it.
  const bottomVisible = chunk && Math.min(scroll, maxScroll) >= maxScroll;
  //
  // This was a `useEffect` calling `persist(...)` (setState) keyed on chunk.id/
  // bottomVisible — same double-commit problem as the lineCur/selAnchor reset
  // above, but INDEPENDENT of it: fixing that one didn't fix this one, which is
  // why the render count didn't actually drop (verified via MRP_DEBUG: still 2
  // renders/keystroke). Most of the the reference MR <Feature> chunks are
  // tiny single-hunk adds, so `bottomVisible` is true immediately on landing —
  // this effect fired on nearly every keystroke through that whole region.
  // Marking engaged during render (same pattern as above) folds the state
  // change into the same commit. The disk write is genuinely a side effect
  // (unlike the pure state reset above), so it stays in a `useEffect` — but
  // that effect only does I/O and never calls setState, so it cannot trigger
  // a further render/repaint. `persist()` is left untouched for every other
  // (user-keystroke-driven) mutation in this file; this is a narrow bypass
  // just for the reactive auto-engagement path.
  const autoEngageDirty = React.useRef(false);
  if (chunk && mode === "view" && !help && bottomVisible && !state.engaged?.[chunk.id]) {
    autoEngageDirty.current = true;
    setState((prev) => {
      const next = structuredClone(prev);
      markEngaged(next, chunk.id);
      return next;
    });
  }
  useEffect(() => {
    if (autoEngageDirty.current) {
      autoEngageDirty.current = false;
      saveState(state);
    }
  }, [state]);

  const moveChunk = (delta) => {
    setIdx((i) => Math.min(Math.max(i + delta, 0), visible.length - 1));
    setScroll(0); // new chunk starts at the top of its diff
  };

  // A new chunk starts with the line cursor at the top and no visual selection —
  // a range must never bleed across chunks. This used to be a `useEffect` keyed
  // on chunk.id, but that fires as a SEPARATE commit after the one that moved
  // `idx` — i.e. every arrow-key press produced two full Ink repaints of the
  // ~sidebarH-row frame, ~20-50ms apart (confirmed via MRP_DEBUG trace: every
  // keystroke logged two identical render frames). Two near-simultaneous
  // full-height repaints are the prime suspect for the WezTerm sidebar
  // corruption (see docs/BUG-sidebar-file-order-corruption.md) — Ink's
  // log-update writer trusts its own erased-line bookkeeping and never
  // re-verifies the terminal applied a write, so a torn/coalesced repaint from
  // a rapid double-write can leave stale content on screen permanently.
  // Resetting during render (React's "adjust state while rendering" pattern)
  // folds this into the SAME commit as the idx change, so each keystroke
  // produces exactly one Ink repaint instead of two.
  const [resetForChunkId, setResetForChunkId] = useState(chunk && chunk.id);
  if ((chunk && chunk.id) !== resetForChunkId) {
    setResetForChunkId(chunk && chunk.id);
    setLineCur(0);
    setSelAnchor(null);
  }

  // Move the hunk line cursor by `delta`, clamped to the body, and scroll just
  // enough to keep the cursor on screen (cursor-follows-view, like a pager).
  const moveLine = (delta) => {
    setLineCur((prev) => {
      const next = Math.min(Math.max(prev + delta, 0), Math.max(0, bodyLen - 1));
      setScroll((s) => {
        if (next < s) return next; // cursor above viewport → scroll up to it
        if (next > s + bodyH - 1) return Math.min(next - bodyH + 1, maxScroll); // below → down
        return Math.min(s, maxScroll);
      });
      return next;
    });
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

    // Warning overlay is open: any key dismisses it (closing = acknowledging).
    if (warnOverlay) {
      setWarnOverlay(false);
      setWarnDismissed(true);
      if (lc === "d") { setDeltaOnly((v) => !v); setIdx(0); setScroll(0); }
      return;
    }

    // Esc closes the importers panel (when nothing else claims Esc). The panel is
    // NOT a modal — normal navigation keeps working while it's open; only `i` and
    // Esc toggle it, handled here / in the `i` key below.
    if (importersOpen && key.escape && selAnchor == null && mode === "view") {
      setImportersOpen(false);
      return;
    }

    // Tab always toggles which pane the arrow/jk keys drive.
    if (key.tab) {
      setFocus((f) => (f === "sidebar" ? "hunk" : "sidebar"));
      return;
    }

    // text-entry modes
    if (mode === "tag" || mode === "search" || mode === "pattern") {
      if (key.return) {
        if (mode === "tag" && chunk) {
          persist((s) => addTag(s, chunk.id, buffer, pendingRange));
          flashMsg(`tagged #${buffer.replace(/^#/, "")}${pendingRange ? " (line-anchored)" : ""}`);
          setPendingRange(null);
          setSelAnchor(null);
        }
        if (mode === "search") { setFilter(buffer); setIdx(0); setScroll(0); }
        if (mode === "pattern") {
          if (buffer && compilePattern(buffer).isLiteral) flashMsg("matched literally (invalid regex — treating as plain text)");
          setPattern(buffer); setIdx(0); setScroll(0);
        }
        setBuffer("");
        setMode("view");
        return;
      }
      if (key.escape) {
        setBuffer("");
        setMode("view");
        setPendingRange(null);
        if (mode === "search") { setFilter(""); setIdx(0); setScroll(0); }
        if (mode === "pattern") { setPattern(""); setIdx(0); setScroll(0); }
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
        setPendingRange(null);
        flashMsg("link cancelled");
        return;
      }
      if (input === "f") {
        // free-pick: leave suggest mode, arm a manual target pick. Remember the
        // source chunk AND keep the captured range for the eventual link.
        setLinkArmed(chunk.id);
        setMode("freepick");
        flashMsg("free-pick: navigate to target, Enter to link (Esc cancels)");
        return;
      }
      const n = parseInt(input, 10);
      if (n >= 1 && n <= suggestions.length) {
        const target = suggestions[n - 1].chunk;
        const range = pendingRange;
        const label = editorPrompt(`${SCAFFOLD} how are these related?\n`);
        persist((s) => addLink(s, chunk.id, target.id, label, range));
        setMode("view");
        setSuggestions([]);
        setPendingRange(null);
        setSelAnchor(null);
        flashMsg(range ? "linked (line-anchored)" : "linked");
      }
      return;
    }

    // identifier-pick mode (* key): choose a shared identifier to set as pattern.
    if (mode === "ident") {
      if (key.escape) { setMode("view"); setIdentCandidates([]); return; }
      const n = parseInt(input, 10);
      if (n >= 1 && n <= identCandidates.length) {
        const { id } = identCandidates[n - 1];
        setPattern(id); setIdx(0); setScroll(0);
        setMode("view"); setIdentCandidates([]);
        flashMsg(`\\${id} — n/N to hop matches, Esc to clear`);
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
        setPendingRange(null);
        flashMsg("link cancelled");
        return;
      }
      if (key.return && chunk && linkArmed && chunk.id !== linkArmed) {
        const range = pendingRange;
        const label = editorPrompt(`${SCAFFOLD} how are these related?\n`);
        persist((s) => addLink(s, linkArmed, chunk.id, label, range));
        setMode("view");
        setLinkArmed(null);
        setPendingRange(null);
        setSelAnchor(null);
        flashMsg(range ? "linked (line-anchored)" : "linked");
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
    if (input === "!" && warnActive) return setWarnOverlay((v) => !v);
    // j/k (and arrows) drive whichever pane has focus: sidebar = move between
    // chunks; hunk = move the line cursor (scroll follows). Tab toggles focus.
    if (key.downArrow || lc === "j") {
      if (focus === "hunk") moveLine(1);
      else moveChunk(1);
    } else if (key.upArrow || lc === "k") {
      if (focus === "hunk") moveLine(-1);
      else moveChunk(-1);
    } else if (key.pageDown || (key.ctrl && lc === "d")) {
      if (focus === "hunk") moveLine(bodyH);
      else setScroll((s) => Math.min(s + bodyH, maxScroll));
    } else if (key.pageUp || (key.ctrl && lc === "u")) {
      if (focus === "hunk") moveLine(-bodyH);
      else setScroll((s) => Math.max(s - bodyH, 0));
    } else if (input === "[") jumpFile(-1);
    else if (input === "]") jumpFile(1);
    else if (input === "}") jumpAnnotated(1);
    else if (input === "{") jumpAnnotated(-1);
    // g/G are case-SIGNIFICANT (top vs bottom) — matched on raw input.
    else if (input === "g") { if (focus === "hunk") moveLine(-bodyLen); else moveChunk(-visible.length); }
    else if (input === "G") { if (focus === "hunk") moveLine(bodyLen); else moveChunk(visible.length); }
    // v — toggle a visual line selection in the hunk pane. Arms an anchor at the
    // cursor; move to extend; a subsequent note/tag/link attaches to the span.
    else if (lc === "v") {
      if (focus !== "hunk") { setFocus("hunk"); setSelAnchor(lineCur); flashMsg("visual: move to extend, n/t/l to annotate, Esc/v to clear"); }
      else if (selAnchor == null) { setSelAnchor(lineCur); flashMsg("visual: move to extend, n/t/l to annotate, Esc/v to clear"); }
      else { setSelAnchor(null); flashMsg("selection cleared"); }
    }
    else if (key.escape && selAnchor != null) { setSelAnchor(null); flashMsg("selection cleared"); }
    else if (input === " ") { if (chunk) persist((s) => toggleSeen(s, chunk.id)); }
    // P (capital, deliberate) — promote a note to a review comment. Leaves the repo.
    else if (input === "P") {
      const notes = (chunk && state.notes[chunk.id]) || [];
      if (!notes.some((n) => !n.promoted)) { flashMsg("no un-promoted note here"); }
      else if (!forge.buildPosition(chunk, detail.diffRefs)) { flashMsg("can't anchor a comment to this hunk"); }
      else {
        const target = detail.forgeName === "github" ? "GitHub PR" : "GitLab MR";
        setConfirmPromote(true);
        flashMsg(`promote note to ${target}? y = post, any key = cancel`);
      }
    }
    else if (lc === "n") {
      if (pattern) {
        // n/N: jump to next/prev pattern match. Works regardless of which pane has
        // focus so you can chase a thread without switching to the sidebar first.
        // visible is already filtered to matching chunks when pattern is active.
        const dir = input === "N" ? -1 : 1;
        const len = visible.length;
        if (len === 0) flashMsg(`no matches for \\${pattern}`);
        else {
          const next = ((safeIdx + dir) % len + len) % len;
          if (next === safeIdx) flashMsg("only one match");
          else { setIdx(next); setScroll(0); }
        }
      } else if (chunk) {
        const range = activeRange();
        const where = range ? (range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`) : chunk.context;
        const text = editorPrompt(`${SCAFFOLD} note on ${chunk.file}\n${SCAFFOLD} ${where}\n\n`);
        if (text) { persist((s) => addNote(s, chunk.id, text, range)); flashMsg(range ? "note saved (line-anchored)" : "note saved"); setSelAnchor(null); }
      }
    } else if (lc === "t") { setPendingRange(activeRange()); setMode("tag"); }
    else if (lc === "z") undo();
    else if (input === "/") { setMode("search"); setBuffer(""); }
    else if (input === "\\") { setMode("pattern"); setBuffer(""); }
    else if (lc === "l") {
      if (chunk) {
        setPendingRange(activeRange());
        const sugg = suggestLinks(chunk, chunks, state, importEdges);
        if (sugg.length) { setSuggestions(sugg); setMode("suggest"); }
        // Only free-pick needs a remembered source: navigation is live there, so
        // the source can't be read off the (moving) selection. Suggest mode links
        // straight from the current chunk.
        else { setLinkArmed(chunk.id); setMode("freepick"); flashMsg("no suggestions — navigate to target, Enter to link"); }
      }
    }
    else if (input === "*") {
      // * — pick a shared identifier from the current chunk to set as pattern.
      if (chunk) {
        const cands = extractIdCandidates(chunk, chunks);
        if (!cands.length) flashMsg("no shared identifiers found in this chunk");
        else { setIdentCandidates(cands); setMode("ident"); }
      }
    }
    else if (lc === "u") { setUnseenOnly((v) => !v); setIdx(0); setScroll(0); }
    else if (lc === "s") { setSharedOnly((v) => !v); setIdx(0); setScroll(0); }
    else if (lc === "d") { setDeltaOnly((v) => !v); setIdx(0); setScroll(0); if (warnActive) { setWarnDismissed(true); setWarnOverlay(false); } }
    // T cycles the test filter: all → hide tests → only tests → all.
    else if (lc === "e") {
      setTestFilter((m) => (m === "all" ? "hide" : m === "hide" ? "only" : "all"));
      setIdx(0); setScroll(0);
    }
    else if (lc === "o") {
      orderAnchor.current = chunk?.id ?? null;
      setOrderMode((m) => (m === "risk" ? "file" : "risk"));
      flashMsg(orderMode === "risk" ? "order: file (grouped, read in place)" : "order: risk (highest-consequence first)");
    }
    // i — toggle the importers panel: WHO imports the current chunk's shared file
    // (the blast radius behind the fan-out count). Only meaningful for shared files.
    else if (lc === "i") {
      if (importersOpen) setImportersOpen(false);
      else if (!chunk) { /* nothing selected */ }
      else if (!chunk.shared) flashMsg("not a shared file — no blast radius to show");
      else if (chunk.unknown) flashMsg("fan-out unassessable (branch not checked out?)");
      else setImportersOpen(true);
    }
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
          h(Text, null, "  Tab        switch focus: sidebar (move chunks) ↔ hunk (line cursor)"),
          h(Text, null, "  j/k ↓/↑    sidebar: prev/next chunk · hunk: move line cursor"),
          h(Text, null, "  PgUp/PgDn  move cursor a page (also Ctrl+u / Ctrl+d)"),
          h(Text, null, "  [ / ]      jump prev / next file"),
          h(Text, null, "  { / }      jump prev / next annotated chunk"),
          h(Text, null, "  g / G      top / bottom (of list, or of hunk when focused)"),
          h(Text, null, "  v          hunk: start/clear a line selection (note/tag/link then anchors to it)"),
          h(Text, null, "  space      ack (done); a chunk is auto-'seen' once its full body is scrolled into view"),
           h(Text, null, "  n / N / t  note ($EDITOR) / next·prev pattern match / tag — line-anchored when a selection is active"),
           h(Text, null, "  P          promote the chunk's note to a review comment on the forge (confirm y)"),
           h(Text, null, "  l          link → pick a suggestion (1-9) or f to free-pick"),
           h(Text, null, "  *          pick a shared identifier from this chunk → sets pattern (n/N to hop)"),
           h(Text, null, "  z          undo last note/tag/link/ack"),
          h(Text, null, "  / u s d e  / find (file · context · notes · tags · body) / unseen / shared / delta / tests"),
          h(Text, null, "  \\          pattern search over hunk bodies with highlighting (regex; Esc=clear)"),
          h(Text, null, "  o          toggle order: risk (consequence-first) ↔ file (grouped, read in place)"),
          h(Text, null, "  i          importers: list the files that import this shared file (blast radius)"),
          h(Text, null, "  ? ! q      help / MR-updated warning / quit"),
          h(Text, { dimColor: true }, "state saves automatically · press ? or Esc to return")))
    : null;

  // Warning overlay: shown when `!` is pressed while the stale-SHA badge is active.
  const warnModal = warnOverlay
    ? h(Box, { justifyContent: "center", width: cols },
        h(Box,
          { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 2, paddingY: 1 },
          h(Text, { bold: true, color: "yellow" }, "⚠  MR updated since last review (head SHA changed)"),
          h(Text, null, ""),
          h(Text, null, `  ${detail.orphanedCount} annotated chunk(s) no longer match the current diff.`),
          h(Text, null, `  ${detail.newCount} new/changed chunk(s) since last review.`),
          h(Text, null, "  Your notes are preserved but may point at shifted lines."),
          h(Text, null, ""),
          h(Text, null, "  Press 'd' to review just the delta, or any key to dismiss.")))
    : null;

  // ---- sidebar ----
  // Build the FULL row list first (every chunk, every file header), then window
  // it around the current selection so a large MR stays navigable: the map must
  // never hide the cursor or silently drop the tail. Each row records the chunk
  // id it belongs to (headers record their first chunk) so the scroll window can
  // center on the selection regardless of order mode.
  const allRows = []; // { key, el, chunkId }
  // Status marks, each in its OWN color so the reviewer can tell at a glance which
  // signal a row carries (seen vs note vs link vs tag) instead of scanning a gray
  // blob. Returns an array of colored <Text> cells, one per mark slot (a space
  // keeps columns aligned when a mark is absent). `dim` follows the row's seen
  // state so acknowledged rows recede.
  //
  // IMPORTANT: pass plain=true for the CURRENT (inverse-highlighted) row. Nesting
  // per-cell `color` inside an `inverse` <Text> makes Ink 5 emit escape sequences
  // whose resets don't fully clear the inverse/color state, which then bleeds onto
  // every row rendered after it (the "everything below the cursor goes foo" bug).
  // A uniform, colorless inverse row composes cleanly.
  const chunkMarkEls = (c, dim, plain) => {
    const seen = state.seen[c.id];
    const eng = state.engaged?.[c.id];
    const hasNote = (state.notes[c.id] || []).length > 0;
    const hasLink = linksFor(state, c.id).length > 0;
    const hasTag = (state.tags[c.id] || []).length > 0;
    const marks = (seen ? "✓" : eng ? "·" : " ") + (hasNote ? "▸" : " ") + (hasLink ? "⇄" : " ") + (hasTag ? "#" : " ");
    if (plain) return [h(Text, { key: "marks" }, marks)]; // single uncolored cell
    return [
      h(Text, { key: "m-s", color: seen ? "green" : undefined, dimColor: dim && !seen }, seen ? "✓" : eng ? "·" : " "),
      h(Text, { key: "m-n", color: hasNote ? "yellow" : undefined, dimColor: dim }, hasNote ? "▸" : " "),
      h(Text, { key: "m-l", color: hasLink ? "magenta" : undefined, dimColor: dim }, hasLink ? "⇄" : " "),
      h(Text, { key: "m-t", color: hasTag ? "cyan" : undefined, dimColor: dim }, hasTag ? "#" : " "),
    ];
  };
  // Row label color: risk dominates (sensitive → red, unknown → yellow, shared →
  // magenta) so risky files pop even without reading the glyph; then new (green) /
  // test (blue); else the theme default. Kept in sync with riskColor's priority.
  const labelColor = (c) =>
    c.sensLabels?.length ? "red"
    : c.unknown ? "yellow"
    : c.shared ? "magenta"
    : c.isNew ? "green"
    : c.isTest ? "blue"
    : undefined;

  if (orderMode === "risk") {
    // Flat, risk-ranked list — display order === navigation order (no teleport).
    // Each row carries its own file so there's no grouping header to imply order.
    visible.forEach((c, i) => {
      const isCur = chunk && c.id === chunk.id;
      const seen = !isCur && state.seen[c.id];
      const shortFile = c.file.replace(/^app\/src\//, "").replace(/^.*\/(?=[^/]+$)/, "");
      const risk = riskGlyph(c);
      const label = `${shortFile} ${chunkLabel(c)}`.slice(0, Math.max(4, sidebarInner - 8));
      allRows.push({ key: c.id, chunkId: c.id, el:
        h(Text, { key: c.id, wrap: "truncate" },
          h(Text, { color: "cyan", bold: true }, isCur ? "▶" : " "),
          h(Text, { color: riskColor(c), dimColor: !c.sensLabels?.length }, risk),
          h(Text, { inverse: isCur }, " ", ...chunkMarkEls(c, seen, isCur), " ",
            h(Text, { color: isCur ? undefined : labelColor(c), dimColor: seen }, label))) });
    });
  } else {
    for (const g of fileGroups) {
      const short = g.file.replace(/^app\/src\//, "").replace(/^.*\/(?=[^/]+\/[^/]+$)/, "…/");
      // File header shows the group's worst risk — fold the chunks into a synthetic
      // risk-like object so the header uses the same glyph/color as the rows.
      const agg = {
        sensLabels: g.chunks.some((c) => c.sensLabels?.length) ? ["_"] : [],
        unknown: g.chunks.some((c) => c.unknown),
        shared: g.chunks.some((c) => c.shared),
      };
      const headGlyph = riskGlyph(agg);
      // Header rows are NOT selectable — they carry `headerFor` (the group's first
      // chunk) only so the scroll window can keep a header on screen with its
      // children. They must never match the current-chunk lookup (which keys on
      // `chunkId`), or the window would center one row above the real selection.
      allRows.push({ key: `f-${g.file}`, headerFor: g.chunks[0]?.id, el:
        h(Text, { key: `f-${g.file}`, bold: true, wrap: "truncate" },
          headGlyph === " " ? "  " : h(Text, { color: riskColor(agg) }, `${headGlyph} `),
          short.slice(0, Math.max(4, sidebarInner - 2))) });
      g.chunks.forEach((c, ci) => {
        const isCur = chunk && c.id === chunk.id;
        const seen = !isCur && state.seen[c.id];
        const isLast = ci === g.chunks.length - 1;
        const connector = isLast ? "└─" : "├─";
        // Per-chunk risk glyph — the file header shows the group's worst risk, but
        // once a file is expanded the reviewer needs to know WHICH chunk carries it.
        // Mirrors the risk-mode row glyph so risk stays legible in either order.
        const risk = riskGlyph(c);
        const label = chunkLabel(c).slice(0, Math.max(4, sidebarInner - 10));
        allRows.push({ key: c.id, chunkId: c.id, el:
          h(Text, { key: c.id, wrap: "truncate" },
            h(Text, { color: "cyan", bold: true }, isCur ? "▶" : " "),
            h(Text, { dimColor: true }, `${connector}`),
            h(Text, { color: riskColor(c), dimColor: !c.sensLabels?.length }, risk),
            h(Text, { inverse: isCur }, " ", ...chunkMarkEls(c, seen), " ",
              h(Text, { color: labelColor(c), dimColor: seen }, label))) });
      });
    }
  }

  // Window the rows so the current chunk is always visible. On a list taller than
  // the pane we show "↑ N more"/"↓ N more" affordances.
  //
  // CONFIRMED ROOT CAUSE (via MRP_DEBUG model trace + raw ANSI capture via
  // `script(1)`, see docs/BUG-sidebar-file-order-corruption.md): every frame in
  // a whole session had exactly 74 embedded newlines — 19 frames straight, zero
  // variance — until the exact frame where the window first needed to show the
  // "↑ N more" row (a brand-new keyed element that had never existed in the
  // tree before that point). That one frame emitted 76 newlines instead of 74,
  // and Ink's terminal writer (log-update.js) blindly erases based on the
  // PREVIOUS frame's line count and never re-verifies the terminal — so that
  // one-time shape change permanently desyncs the erase/cursor bookkeeping for
  // every frame after it. This is why it's always the same spot for a given MR
  // + terminal size (deterministic: whichever row first needs a "more" row),
  // why it moves after a resize (that row is a function of sidebarH/cols), and
  // why it never self-heals (log-update has no correction mechanism).
  //
  // Fix: make the "↑ more"/"↓ more" slots ALWAYS-MOUNTED, fixed-position rows
  // (blank when not needed) instead of conditionally inserting/removing them.
  // They exist in the tree from the very first render, so this exact
  // first-appearance event can never happen again. Always reserve their 2
  // rows from the content budget up front (rather than relying on
  // computeSidebarWindow's own capacity optimization, which is left
  // untouched — it's pure/unit-tested) so the total rendered row count is
  // 100% stable across every render, not just "numerically equal but
  // differently composed."
  const headerRows = 1; // the "MAP … order:" title line
  const sidebarH = Math.max(3, appH - 2 - headerRows); // usable rows inside the bordered box
  const total = allRows.length;
  const curRowIdx = chunk ? sidebarRowIndex(allRows, chunk.id) : 0;
  const contentH = Math.max(1, sidebarH - 2); // 2 rows permanently reserved for the affordances
  const { start, end, above, below } = computeSidebarWindow(total, curRowIdx, contentH);

  const sidebarRows = [
    h(Text, { key: "s-up", dimColor: true }, above ? `  ↑ ${above} more` : ""),
    ...allRows.slice(start, end).map((r) => r.el),
    h(Text, { key: "s-dn", dimColor: true }, below ? `  ↓ ${below} more` : ""),
  ];

  if (process.env.MRP_DEBUG) {
    try {
      appendFileSync(process.env.MRP_DEBUG, JSON.stringify({
        t: Date.now(), cols, rows, appH, sidebarW, sidebarH, bodyH,
        orderMode, idx, safeIdx, chunkId: chunk?.id,
        total, curRowIdx, start, end, above, below,
        renderedRows: sidebarRows.length,
        winRows: allRows.slice(start, end).map(r =>
          r.chunkId ? "C:" + r.chunkId.split("/").pop()
                    : "H:" + (r.headerFor||"").split("/").pop()),
      }) + "\n");
    } catch (e) { appendFileSync(process.env.MRP_DEBUG, "ERR " + e.message + "\n"); }
  }

  const sidebar = h(Box,
    { flexDirection: "column", width: sidebarW, height: "100%", overflow: "hidden", marginRight: 1, borderStyle: "round", borderColor: focus === "sidebar" ? "cyan" : undefined, borderDimColor: focus !== "sidebar", paddingX: 1 },
    h(Text, { bold: focus === "sidebar" }, focus === "sidebar" ? h(Text, { color: "cyan" }, "▶ MAP ") : h(Text, { dimColor: true }, "  MAP "), h(Text, { dimColor: true }, `${visible.length}ch · order:`), h(Text, { color: "yellow" }, orderMode)),
    ...sidebarRows);

  // ---- right pane ----
  let rightChildren;
  if (!chunk) {
    rightChildren = [
      h(Text, { key: "e", color: "yellow" },
        pattern
          ? `No chunks match \\${pattern} (pattern filter active).`
          : "No chunks match the current filter."),
      h(Text, { key: "h", dimColor: true }, "u=unseen s=shared /=search \\ pattern (Esc clears) · q quit"),
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
  } else if (mode === "ident") {
    // identifier-pick panel — * key
    rightChildren = [
      h(Text, { key: "t", bold: true, color: "cyan" }, `Identifiers: ${chunkLabel(chunk)}`),
      h(Text, { key: "f", dimColor: true }, chunk.file),
      h(Text, { key: "sp" }, " "),
      h(Text, { key: "hd", bold: true }, "Shared identifiers — press number to search, Esc=cancel"),
      ...identCandidates.map((c, i) =>
        h(Text, { key: c.id },
          h(Text, { color: "cyan" }, ` ${i + 1} `),
          h(Text, { color: "yellow" }, c.id),
          h(Text, { dimColor: true }, `  ×${c.count} other chunk${c.count === 1 ? "" : "s"}`))),
    ];
  } else {
    const clampScroll = Math.min(scroll, maxScroll);
    const shown = numbered.slice(clampScroll, clampScroll + bodyH);
    const compiledPat = pattern ? compilePattern(pattern) : null;
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
    const opBadge = chunk.op
      ? { renamed: "[renamed]", deleted: "[deleted]", added: "[added]" }[chunk.op]
      : null;
    const badges = [
      chunk.sensLabels?.length ? h(Text, { key: "b-sens", color: "red", bold: true }, `⚠ ${chunk.sensLabels.join("/")} `) : null,
      chunk.isNew ? h(Text, { key: "b-new", color: "green", bold: true }, "[new] ") : null,
      // File operation (rename/delete/add). A metadata-only move has nothing to
      // review, so it's dimmed; a delete or a rename-with-edits is not.
      opBadge ? h(Text, { key: "b-op", color: chunk.op === "deleted" ? "red" : "cyan", dimColor: chunk.metaOnly }, `${opBadge}${chunk.metaOnly ? " (no content change)" : ""} `) : null,
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
      h(Box, { key: "body", flexGrow: 1, flexDirection: "column", borderStyle: "round", borderDimColor: focus !== "hunk", borderColor: focus === "hunk" ? "cyan" : undefined, paddingX: 1 },
        above > 0 ? h(Text, { key: "up", dimColor: true }, `  ↑ ${above} more above`) : null,
        ...shown.map((r, i) => {
          const abs = clampScroll + i;
          const c0 = r.line[0];
          const numColor = c0 === "+" ? "green" : c0 === "-" ? "red" : undefined;
          // Cursor line (only when the hunk pane is focused) and visual-selection
          // span are inverse-highlighted so the reviewer sees exactly what a
          // note/tag/link will anchor to.
          const isCursor = focus === "hunk" && abs === lineCur;
          const selLo = selAnchor == null ? -1 : Math.min(selAnchor, lineCur);
          const selHi = selAnchor == null ? -2 : Math.max(selAnchor, lineCur);
          const inSel = abs >= selLo && abs <= selHi;
          // When a pattern is active, highlight matched substrings in added/context
          // lines with bold+underline. Bold+underline composes cleanly inside an
          // inverse row; per-cell `color` changes inside `inverse` are what leaks
          // escape state (see chunkMarkEls comment above), not bold/underline.
          const lineColor = diffLineColor(r.line);
          const patEligible = compiledPat && r.line[0] !== "-" && r.line[0] !== "@";
          const lineEls = patEligible
            ? highlightSegments(r.line || " ", compiledPat).map((seg, si) =>
                h(Text, { key: si, color: lineColor, bold: seg.matched, underline: seg.matched }, seg.text))
            : [h(Text, { key: "t", color: lineColor }, r.line || " ")];
          return h(Text, { key: i, wrap: "truncate", inverse: isCursor || inSel },
            h(Text, { color: numColor, dimColor: !numColor }, (r.num ? String(r.num) : "").padStart(gw) + " "),
            ...lineEls);
        }),
        below > 0 ? h(Text, { key: "dn", color: "yellow" }, `  ↓ ${below} more below${focus !== "hunk" ? " (Tab → hunk to scroll)" : ""}`) : null),
      tags.length ? h(Text, { key: "tags" }, ...tags.map((t, ti) => h(Text, { key: `${tagName(t)}-${ti}`, color: "cyan" }, `#${tagName(t)}${fmtRange(tagRange(t))} `))) : null,
      ...notes.map((nt, i) => h(Text, { key: `n${i}`, color: "yellow", wrap: "truncate" }, `  ${nt.promoted ? "▲" : "▸"}${fmtRange(nt.range)} ${nt.text.replace(/\n/g, " ⏎ ")}${nt.promoted ? " (posted)" : ""}`)),
      ...links.map((l, i) => {
        const other = l.from === chunk.id ? l.to : l.from;
        const arrow = l.from === chunk.id ? "→" : "←";
        return h(Text, { key: `l${i}`, color: "magenta", wrap: "truncate" }, `  ⇄ ${arrow}${fmtRange(l.range)} ${other}${l.label ? ` (${l.label})` : ""}`);
      }),
      // ---- importers panel (docked at the bottom of the hunk pane) ----
      // Toggled with `i`. Lists the files that import this shared module — the
      // concrete blast radius behind the fan-out count. Capped to a few rows so it
      // never eats the whole pane; a "+N more" tail shows the rest exists.
      importersOpen ? (() => {
        const all = chunk.importers || [];
        const cap = Math.max(3, Math.floor(bodyH / 2)); // at most half the pane
        const shown = all.slice(0, cap);
        const rest = all.length - shown.length;
        return h(Box, { key: "importers", flexDirection: "column", borderStyle: "round", borderColor: "magenta", borderDimColor: true, paddingX: 1 },
          h(Text, { bold: true, color: "magenta", wrap: "truncate" },
            `◆ importers · ${all.length} file(s) import this module`,
            h(Text, { dimColor: true }, "  (i/Esc to close)")),
          ...(all.length
            ? shown.map((f, i) =>
                h(Text, { key: f, wrap: "truncate" },
                  h(Text, { dimColor: true }, `${String(i + 1).padStart(3)} `),
                  h(Text, null, f.replace(/^app\/src\//, "").slice(0, paneW - 6))))
            : [h(Text, { key: "none", dimColor: true }, "  (no importers found — reach of 0)")]),
          rest > 0 ? h(Text, { key: "more", dimColor: true }, `  … +${rest} more`) : null);
      })() : null,
    ];
  }

  // Footer shows only the keys valid right now (lazygit-style), driven by
  // mode and — in view mode — the focused pane.
  const viewKeys =
    focus === "hunk"
      ? `j/k line · v ${selAnchor != null ? "clear-sel" : "select"} · PgUp/PgDn page · g/G top/bottom · Tab →sidebar · space seen · n${pattern ? "/N match" : " note"} · t tag · l link · z undo · ? help · q quit`
      : `j/k move · [ ] file · } { annot · space ack · ${pattern ? "n/N match · " : "n note · "}P post · t tag · l link · z undo · / find · \\ pattern · u/s/d/e filter · o order · i importers · ? help · q quit`;
  const activeFilters = [
    unseenOnly && "unseen",
    sharedOnly && "shared",
    deltaOnly && "delta",
    testFilter !== "all" && `tests:${testFilter}`,
    filter && `/${filter}`,
    pattern && `\\${pattern}`,
  ].filter(Boolean);
  const footer =
    confirmPromote ? h(Text, { color: "yellow", bold: true }, "post this note to GitLab as a comment?  y = post · any other key = cancel")
    : mode === "tag" ? h(Text, { color: "cyan" }, `tag: ${buffer}▌  (Enter=save, Esc=cancel)`)
    : mode === "search" ? h(Text, { color: "cyan" }, `/${buffer}▌  (Enter=apply, Esc=clear)`)
    : mode === "pattern" ? h(Text, { color: "yellow" }, `\\${buffer}▌  (regex over +/context lines · Enter=apply, Esc=clear)`)
    : mode === "suggest" ? h(Text, { color: "magenta" }, "pick: 1-9=link · f=free-pick · Esc=cancel")
    : mode === "ident" ? h(Text, { color: "cyan" }, "pick: 1-9=search identifier · Esc=cancel")
    : mode === "freepick" ? h(Text, { color: "magenta" }, "free-pick: navigate to target, Enter=link, Esc=cancel")
    : flash ? h(Text, { color: "green" }, flash)
    : h(Text, { dimColor: true }, `${viewKeys}${activeFilters.length ? `  [${activeFilters.join(" ")}]` : ""}`);

  // Render ONE line short of the terminal height (see appH above). Leaving one
  // spare line keeps every repaint in place instead of scroll-desyncing Ink.
  return h(Box, { flexDirection: "column", height: appH, width: cols },
    h(Box, { key: "hd", justifyContent: "space-between" },
      h(Text, { key: "l" },
        h(Text, { color: "magenta", bold: true }, "▚▞ mrp"),
        h(Text, { dimColor: true }, " · "),
        h(Text, { bold: true }, `!${detail.iid}`), " ",
        h(Text, { dimColor: true }, detail.title.slice(0, Math.max(16, cols - 52)))),
      h(Text, { key: "r" },
        warnActive ? h(Text, { color: "yellow" }, `⚠ +${detail.newCount} ~${detail.orphanedCount}  `) : null,
        h(Text, { dimColor: true }, `${safeIdx + 1}/${visible.length} · ackd ${seenCount} · seen ${engagedCount}/${chunks.length}${riskyUnengaged ? ` · ⚠ ${riskyUnengaged} risky unseen` : ""} · ${noteCount} notes`))),
    // The middle row grows to fill everything between the header and footer, so
    // the panes always occupy the full terminal height regardless of diff length.
    // overflow:hidden on the row AND each pane is CRITICAL: a tall hunk body or a
    // long sidebar must be clipped to its box, or Ink's flex layout lets the
    // overflow shove sibling rows around — which looked like the sidebar "jumping
    // around" on large MRs (e.g. a 473-line new file in the right pane).
    warnOverlay
      ? h(Box, { key: "cols", flexGrow: 1, overflow: "hidden" }, warnModal)
      : help
      ? h(Box, { key: "cols", flexGrow: 1, overflow: "hidden" }, helpModal)
      : h(Box, { key: "cols", flexGrow: 1, overflow: "hidden" },
          sidebar,
          h(Box, { flexDirection: "column", width: paneW, height: "100%", overflow: "hidden" }, ...rightChildren)),
    h(Box, { key: "ft" }, footer));
}
