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

// Reconcile persisted state with a freshly-fetched revision.
//   - staleSha:    the MR head moved since last review (force-push / new commits).
//   - orphaned:    annotated chunk ids absent from the new diff OR present but with
//                  a different contentHash (annotations now point at different code).
//   - newIds:      chunks present now but NOT in the last reviewed revision, OR
//                  present with a different contentHash — the delta to re-review.
//   - changedCount: subset of newIds whose id existed before but hash changed.
//
// 4th parameter: array of { id, contentHash } objects.
// Migration: old state carries reviewedChunkIds (string[]) but no reviewedChunks.
//   First run after upgrade uses id-only comparison; full hash detection starts
//   from the second run once reviewedChunks has been written.
export function reconcile(state, headSha, fetchedAt, chunks) {
  const staleSha = !!state.headSha && state.headSha !== headSha;

  // Snapshot the PREVIOUS stored hashes before mutating state.
  const prevChunks = state.reviewedChunks || null;   // { [id]: hash } | null
  const prevIds    = state.reviewedChunkIds || null;  // string[] | null (legacy)

  // Build id→hash map for this revision.
  const incoming = new Map(chunks.map((c) => [c.id, c.contentHash]));

  // --- Delta: which chunks are new or content-changed? ---
  const newIds = [];
  let changedCount = 0;

  if (prevChunks) {
    for (const [id, hash] of incoming) {
      if (!(id in prevChunks)) {
        newIds.push(id);                         // new id
      } else if (prevChunks[id] !== hash) {
        newIds.push(id);                         // same id, different content
        changedCount++;
      }
    }
  } else if (prevIds) {
    // Legacy: no stored hash — id-only comparison.
    const prevSet = new Set(prevIds);
    for (const [id] of incoming) if (!prevSet.has(id)) newIds.push(id);
  }
  // No previous state → first review; newIds empty (whole MR new implicitly).

  // --- Orphaned: annotated chunks gone OR content-changed ---
  const annotated = new Set([
    ...Object.keys(state.notes),
    ...Object.keys(state.tags),
    ...Object.keys(state.seen),
    ...Object.keys(state.engaged || {}),
  ]);
  const orphaned = [];
  for (const id of annotated) {
    if (!incoming.has(id)) {
      orphaned.push(id); // absent from new diff entirely
    } else if (prevChunks && id in prevChunks && prevChunks[id] !== incoming.get(id)) {
      orphaned.push(id); // content changed — prior annotation points at different code
    }
  }

  // --- Persist this revision as the new delta base ---
  state.headSha = headSha;
  state.fetchedAt = fetchedAt;
  state.reviewedChunks  = Object.fromEntries(incoming);  // new field
  state.reviewedChunkIds = [...incoming.keys()];          // keep for back-compat

  return { staleSha, orphaned, newIds, changedCount };
}

// ---- mutation helpers (each returns the mutated state; caller saves) ----
// `range` (optional) anchors an annotation to specific new-file lines within the
// chunk: { start, end } inclusive, new-side line numbers. Absent/null = the whole
// chunk (legacy behavior — still fully supported).
export function addNote(state, chunkId, text, range = null) {
  if (!text || !text.trim()) return state;
  const note = { text: text.trim(), at: new Date().toISOString() };
  if (range) note.range = range;
  (state.notes[chunkId] ||= []).push(note);
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

export function addTag(state, chunkId, tag, range = null) {
  const t = (tag || "").trim().replace(/^#/, "");
  if (!t) return state;
  // Chunk-level tags stay a flat string list (back-compat). A ranged tag is
  // stored as an object so it can carry its line span without breaking the
  // "already has this tag" de-dup for the plain case.
  const list = (state.tags[chunkId] ||= []);
  if (range) {
    const exists = list.some((x) => typeof x === "object" && x.tag === t && x.range?.start === range.start && x.range?.end === range.end);
    if (!exists) list.push({ tag: t, range });
  } else if (!list.some((x) => (typeof x === "object" ? x.tag : x) === t)) {
    list.push(t);
  }
  return state;
}

export function addLink(state, from, to, label, range = null) {
  if (!from || !to || from === to) return state;
  const exists = state.links.some((l) => l.from === from && l.to === to);
  if (!exists) {
    const link = { from, to, label: (label || "").trim(), at: new Date().toISOString() };
    if (range) link.range = range;
    state.links.push(link);
  }
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

// A tag entry is either a bare string (chunk-level, legacy) or { tag, range }
// (line-anchored). These two readers are the single place that knows the union
// shape — every consumer goes through them so the string|object split can't leak.
export function tagName(t) {
  return typeof t === "object" && t ? t.tag : t;
}
export function tagRange(t) {
  return typeof t === "object" && t ? t.range || null : null;
}
