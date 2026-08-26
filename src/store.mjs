// store.mjs — per-MR local review state: notes, tags, chunk links, seen marks.
//
// One JSON file per MR under ~/.local/share/mrp/<project-slug>/<iid>.json.
// Keyed by headSha: if the MR is force-pushed the SHA changes, so we can detect
// that annotations were made against an older revision and warn instead of
// silently re-attaching to shifted lines.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { projectSlug } from "./gitlab.mjs";

function storePath(project, iid) {
  return join(
    homedir(),
    ".local",
    "share",
    "mrp",
    projectSlug(project),
    `${iid}.json`,
  );
}

const emptyState = (project, iid) => ({
  project,
  iid,
  headSha: null,
  fetchedAt: null,
  seen: {}, // chunkId -> true
  notes: {}, // chunkId -> [{ text, at }]
  tags: {}, // chunkId -> [tag,...]
  links: [], // [{ from, to, label, at }]
});

export function loadState(project, iid) {
  const p = storePath(project, iid);
  if (!existsSync(p)) return emptyState(project, iid);
  try {
    return { ...emptyState(project, iid), ...JSON.parse(readFileSync(p, "utf8")) };
  } catch {
    return emptyState(project, iid);
  }
}

export function saveState(state) {
  const p = storePath(state.project, state.iid);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

// Reconcile persisted state with a freshly-fetched revision. If the head SHA
// changed, keep the annotations but record that they predate this revision so
// the UI can flag chunks whose id no longer exists in the new diff.
export function reconcile(state, headSha, fetchedAt, chunkIds) {
  const staleSha = state.headSha && state.headSha !== headSha;
  state.headSha = headSha;
  state.fetchedAt = fetchedAt;
  const idSet = new Set(chunkIds);
  // Chunks that carry annotations but are absent from the new diff = orphaned.
  const orphaned = [];
  const annotated = new Set([
    ...Object.keys(state.notes),
    ...Object.keys(state.tags),
    ...Object.keys(state.seen),
  ]);
  for (const id of annotated) if (!idSet.has(id)) orphaned.push(id);
  return { staleSha, orphaned };
}

// ---- mutation helpers (each returns the mutated state; caller saves) ----
export function addNote(state, chunkId, text) {
  if (!text || !text.trim()) return state;
  (state.notes[chunkId] ||= []).push({ text: text.trim(), at: new Date().toISOString() });
  return state;
}

export function toggleSeen(state, chunkId) {
  if (state.seen[chunkId]) delete state.seen[chunkId];
  else state.seen[chunkId] = true;
  return state;
}

export function addTag(state, chunkId, tag) {
  const t = (tag || "").trim().replace(/^#/, "");
  if (!t) return state;
  const list = (state.tags[chunkId] ||= []);
  if (!list.includes(t)) list.push(t);
  return state;
}

export function addLink(state, from, to, label) {
  if (!from || !to || from === to) return state;
  const exists = state.links.some((l) => l.from === from && l.to === to);
  if (!exists)
    state.links.push({ from, to, label: (label || "").trim(), at: new Date().toISOString() });
  return state;
}

export function linksFor(state, chunkId) {
  return state.links.filter((l) => l.from === chunkId || l.to === chunkId);
}
