// export.mjs — turn a review (state + scored chunks) into a structured artifact.
//
// This is the P0 "findings must leave the laptop" exit (see DECISIONS.md and
// docs/SPEC-promote-and-export.md). Pure functions: build the object, render it.
// No I/O here — the caller decides stdout vs file.

import { linksFor, tagName, tagRange } from "./store.mjs";

// Build the v1 export object from review state + scored chunks + MR detail.
// `all=false` (default) emits only annotated chunks (notes/tags/links/seen/engaged);
// `all=true` emits every chunk with its risk score (triage analytics).
export function buildExport(state, chunks, detail, { all = false } = {}) {
  const isAnnotated = (c) =>
    (state.notes[c.id]?.length || 0) > 0 ||
    (state.tags[c.id]?.length || 0) > 0 ||
    linksFor(state, c.id).length > 0 ||
    !!state.seen[c.id] ||
    !!state.engaged?.[c.id];

  const selected = all ? chunks : chunks.filter(isAnnotated);

  const findings = selected.map((c) => {
    const notes = (state.notes[c.id] || []).map((n) => ({
      text: n.text,
      at: n.at,
      promoted: !!n.promoted,
      ...(n.range ? { range: n.range } : {}),
    }));
    // Links emitted once, from the `from` side, to avoid double-counting.
    const links = (state.links || [])
      .filter((l) => l.from === c.id)
      .map((l) => ({ to: l.to, label: l.label || "", ...(l.range ? { range: l.range } : {}) }));
    // Tags normalized to a uniform { tag, range? } shape regardless of whether
    // they were stored as a bare string (chunk-level) or an object (line-anchored).
    const tags = (state.tags[c.id] || []).map((t) => {
      const r = tagRange(t);
      return r ? { tag: tagName(t), range: r } : { tag: tagName(t) };
    });
    return {
      chunk: c.id,
      file: c.file,
      risk: Math.round(c.risk ?? 0),
      sensitivity: c.sensLabels || [],
      fanOut: c.fanOut ?? 0,
      shared: !!c.shared,
      unknown: !!c.unknown,
      isNew: !!c.isNew,
      op: c.op || null,
      metaOnly: !!c.metaOnly,
      seen: !!state.seen[c.id],
      engaged: !!state.engaged?.[c.id],
      notes,
      tags,
      links,
    };
  });

  const noteCount = Object.values(state.notes).reduce((s, a) => s + a.length, 0);
  return {
    schema: "mrp.export/1",
    project: state.project,
    iid: detail?.iid ?? state.iid,
    headSha: state.headSha,
    exportedAt: new Date().toISOString(),
    summary: {
      chunks: chunks.length,
      seen: Object.keys(state.seen).length,
      engaged: Object.keys(state.engaged || {}).length,
      annotated: chunks.filter(isAnnotated).length,
      notes: noteCount,
      tags: Object.keys(state.tags).length,
      links: (state.links || []).length,
      sensitiveChunks: chunks.filter((c) => c.sensLabels?.length).length,
      unknownChunks: chunks.filter((c) => c.unknown).length,
    },
    findings,
  };
}

// Render the export object as a human-readable Markdown review summary — the
// "handoff" artifact (paste into an MR description or a ticket). Findings are
// shown in the order given (caller passes risk-sorted chunks).
export function toMarkdown(ex) {
  const L = [];
  L.push(`# Review of !${ex.iid} — ${ex.project}`);
  L.push("");
  L.push(`_head \`${ex.headSha || "?"}\` · exported ${ex.exportedAt}_`);
  L.push("");
  const s = ex.summary;
  L.push(
    `**${s.annotated}/${s.chunks} chunks annotated** · ${s.engaged} seen · ` +
      `${s.notes} notes · ${s.tags} tags · ${s.links} links · ` +
      `${s.sensitiveChunks} sensitive · ${s.unknownChunks} unassessed`,
  );
  L.push("");
  if (!ex.findings.length) {
    L.push("_No annotated findings._");
    return L.join("\n");
  }
  L.push("## Findings");
  for (const f of ex.findings) {
    const badges = [
      ...(f.sensitivity.length ? [`⚠ ${f.sensitivity.join("/")}`] : []),
      ...(f.isNew ? ["new"] : []),
      ...(f.op ? [`${f.op}${f.metaOnly ? " (no content change)" : ""}`] : []),
      ...(f.unknown ? ["unassessed"] : []),
      ...(f.shared ? [`shared${f.fanOut ? ` ·${f.fanOut}` : ""}`] : []),
    ];
    L.push("");
    L.push(`### \`${f.file}\`  ${badges.length ? `— ${badges.join(", ")}` : ""}`.trim());
    L.push(`- chunk: \`${f.chunk}\` · risk ${f.risk}${f.seen ? " · acked" : ""}`);
    for (const t of f.tags) L.push(`- tag: #${t.tag}${fmtRange(t.range)}`);
    for (const n of f.notes) L.push(`- note${n.promoted ? " (posted)" : ""}${fmtRange(n.range)}: ${n.text.replace(/\n/g, " ")}`);
    for (const l of f.links) L.push(`- link → \`${l.to}\`${l.label ? ` (${l.label})` : ""}${fmtRange(l.range)}`);
  }
  return L.join("\n");
}

// " @L12" for a single line, " @L12-18" for a span, "" when chunk-level.
function fmtRange(r) {
  if (!r) return "";
  return r.start === r.end ? ` @L${r.start}` : ` @L${r.start}-${r.end}`;
}
