// risk.mjs — display helpers + scoreChunks re-export.
//
// The scoring logic moved to src/pipeline.mjs (configurable pipeline).
// This file keeps the display helpers (riskGlyph, riskColor, riskOrder,
// orderChunks, sidebarRowIndex, computeSidebarWindow) and the SHARED_RE/TEST_RE
// re-exports so existing callers need no import-path changes.

import { SHARED_RE, TEST_RE } from "./paths.mjs";
import { depsOrder } from "./depssort.mjs";
export { SHARED_RE, TEST_RE };

export { scoreChunks } from "./pipeline.mjs";

// Single source of truth for how a chunk's risk renders. The sidebar shows this
// in three places (risk-mode row, file-mode chunk row, and — aggregated — the
// file header); keeping the glyph/color here stops those from drifting apart.
// Priority: sensitive (consequence) > unknown (unassessable) > shared (reach).
// Pass a chunk, or a synthetic {sensLabels, unknown, shared} for the file header.
export function riskGlyph(c) {
  return c.sensLabels?.length ? "⚠" : c.unknown ? "?" : c.shared ? "◆" : " ";
}
export function riskColor(c) {
  return c.sensLabels?.length ? "red" : c.unknown ? "yellow" : c.shared ? "magenta" : "gray";
}

// Stable sort: highest risk first, then by file+position for determinism.
export function riskOrder(chunks) {
  return [...chunks].sort(
    (a, z) =>
      z.risk - a.risk ||
      a.file.localeCompare(z.file) ||
      a.newStart - z.newStart,
  );
}

// Presentation order for the walk + sidebar (they MUST share one ordering or the
// cursor "teleports"). Input is assumed risk-sorted.
//   "risk":  unchanged — flat, highest-consequence first.
//   "file":  grouped by file (files ordered by their riskiest chunk = first
//            occurrence in the risk-sorted input), chunks within file top-to-bottom.
//   "deps":  grouped by file in intra-MR topological order (foundations first,
//            consumers last, tests always last). Falls back to "file" order when
//            intraEdges is absent or contains no intra-MR edges.
//
// opts.intraEdges — Map<path,Set<path>> from buildIntraEdges() in depssort.mjs.

function groupByFile(chunks) {
  const groups = new Map();
  for (const c of chunks) {
    if (!groups.has(c.file)) groups.set(c.file, []);
    groups.get(c.file).push(c);
  }
  const ordered = [];
  for (const arr of groups.values()) {
    arr.sort((a, z) => (a.newStart || 0) - (z.newStart || 0));
    ordered.push(...arr);
  }
  return ordered;
}

export function orderChunks(chunks, mode, { intraEdges } = {}) {
  if (mode === "deps" && intraEdges) {
    const files = [...new Set(chunks.map((c) => c.file))];
    const order = depsOrder(files, intraEdges);
    if (order) {
      const byFile = new Map();
      for (const c of chunks) {
        if (!byFile.has(c.file)) byFile.set(c.file, []);
        byFile.get(c.file).push(c);
      }
      const result = [];
      for (const f of order) {
        const arr = byFile.get(f) ?? [];
        arr.sort((a, z) => (a.newStart || 0) - (z.newStart || 0));
        result.push(...arr);
      }
      return result;
    }
    // No edges detected — fall through to file grouping below.
  }
  if (mode !== "file" && mode !== "deps") return [...chunks];
  return groupByFile(chunks);
}

// Locate the current chunk's row in the sidebar row list. `rows` is the flat list
// the sidebar renders: chunk rows carry `chunkId`; file-header rows do NOT (they
// carry `headerFor` only, as a scroll anchor). This lookup MUST match on `chunkId`
// exclusively — a header sharing the current chunk's id would otherwise be found
// first and mis-center the scroll window by one row (the file-order highlight bug).
// Returns the row index, or 0 when not found (empty list / no selection).
export function sidebarRowIndex(rows, curId) {
  const i = rows.findIndex((r) => r.chunkId != null && r.chunkId === curId);
  return i < 0 ? 0 : i;
}

// Compute the visible window over `total` sidebar rows so that `curRowIdx` stays
// on screen, reserving a row for each "↑/↓ N more" affordance that is actually
// shown. Pure math (no rendering) so it can be unit-tested. Returns
// { start, end, above, below } where [start,end) is the slice of rows to render.
export function computeSidebarWindow(total, curRowIdx, sidebarH) {
  if (total <= sidebarH) return { start: 0, end: total, above: 0, below: 0 };
  const windowFor = (cap) =>
    Math.min(Math.max(0, curRowIdx - Math.floor(cap / 2)), total - cap);
  // Assume both indicators first (worst case), then relax if pinned to an end.
  let capacity = sidebarH - 2;
  let start = windowFor(capacity);
  let above = start > 0;
  let below = start + capacity < total;
  if (!above || !below) {
    capacity = sidebarH - 1;
    start = windowFor(capacity);
    above = start > 0;
    below = start + capacity < total;
  }
  const end = Math.min(total, start + capacity);
  return { start, end, above: above ? start : 0, below: below ? total - end : 0 };
}
