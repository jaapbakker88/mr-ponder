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
  reviewedChunkIds: null, // chunk ids present at the last reviewed revision (delta base)
  seen: {}, // chunkId -> true  (manual ACK: "I'm done with this")
  engaged: {}, // chunkId -> true  (OBSERVED: full hunk body was scrolled into view)
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
// Reconcile persisted state with a freshly-fetched revision.
//   - staleSha: the MR head moved since last review (force-push / new commits).
//   - orphaned: annotated chunk ids absent from the new diff (notes may drift).
//   - newIds:   chunk ids present now but NOT in the last reviewed revision — the
//               DELTA to focus a re-review on. Empty on a first review (nothing to
//               compare against) so the whole MR reads as "new" only implicitly.
// The set of chunk ids at the reviewed revision is persisted as reviewedChunkIds
// so the next re-review diffs against THIS pass, not the original.
export function reconcile(state, headSha, fetchedAt, chunkIds) {
  const staleSha = !!state.headSha && state.headSha !== headSha;
  const idSet = new Set(chunkIds);

  // Delta vs the previously-reviewed revision (only meaningful once we've stored
  // a prior set — i.e. this isn't the first-ever review).
  const prevReviewed = state.reviewedChunkIds || null;
  const newIds = [];
  if (prevReviewed) {
    const prevSet = new Set(prevReviewed);
    for (const id of chunkIds) if (!prevSet.has(id)) newIds.push(id);
  }

  state.headSha = headSha;
  state.fetchedAt = fetchedAt;
  state.reviewedChunkIds = chunkIds; // remember this revision's shape

  // Chunks that carry annotations but are absent from the new diff = orphaned.
  const orphaned = [];
  const annotated = new Set([
    ...Object.keys(state.notes),
    ...Object.keys(state.tags),
    ...Object.keys(state.seen),
    ...Object.keys(state.engaged || {}),
  ]);
  for (const id of annotated) if (!idSet.has(id)) orphaned.push(id);
  return { staleSha, orphaned, newIds };
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

// Mark a chunk as ENGAGED — the reviewer actually scrolled its full body into
// view. Unlike seen (a manual ack), this is observed and one-way (never unset):
// you can't un-see something. This is the honest coverage signal.
export function markEngaged(state, chunkId) {
  if (!state.engaged) state.engaged = {};
  state.engaged[chunkId] = true;
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

// Mark the i-th note of a chunk as promoted (posted to GitLab), recording where.
// Called only after a successful POST so a failed promotion never looks posted.
export function markNotePromoted(state, chunkId, noteIndex, meta) {
  const notes = state.notes[chunkId];
  if (!notes || !notes[noteIndex]) return state;
  notes[noteIndex].promoted = {
    at: new Date().toISOString(),
    discussionId: meta?.discussionId || null,
    headSha: meta?.headSha || null,
  };
  return state;
}

export function linksFor(state, chunkId) {
  return state.links.filter((l) => l.from === chunkId || l.to === chunkId);
}
