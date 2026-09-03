// diff.mjs — parse GitLab's unified per-file diffs into individual hunks.
//
// A "chunk" here == one @@ hunk of one file, the same unit `git add -p` walks.
// Each chunk gets a STABLE id (file + old/new start lines) so notes re-attach
// correctly after a re-fetch, as long as the hunk didn't move.
// Each chunk also carries a contentHash (FNV-1a 32-bit of the normalised body)
// so a force-push that rewrites content without shifting line numbers is caught.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// FNV-1a 32-bit hash — dependency-free, fast enough for change detection.
// Not cryptographic; purpose is equality comparison across re-fetches.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Hash the body lines of a chunk, normalising line endings so CRLF<->LF changes
// don't produce spurious deltas.
function hashBody(bodyLines) {
  return fnv1a(bodyLines.join("\n").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}

// Split one file's `diff` string into hunk objects.
export function parseFileHunks(file) {
  const path = file.new_path || file.old_path || "";
  const raw = file.diff || "";
  const lines = raw.split("\n");

  // File-level operation flags, normalized once so every synthetic/real hunk
  // carries the same signal. `op` is the single categorical label the UI, risk
  // scorer, and export read; the booleans stay for back-compat.
  const newFile = !!file.new_file;
  const deletedFile = !!file.deleted_file;
  const renamedFile = !!file.renamed_file;
  const op = deletedFile ? "deleted" : newFile ? "added" : renamedFile ? "renamed" : null;

  const hunks = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(HUNK_RE);
    if (m) {
      if (current) {
        current.contentHash = hashBody(current.body);
        hunks.push(current);
      }
      const oldStart = parseInt(m[1], 10);
      const oldCount = m[2] ? parseInt(m[2], 10) : 1;
      const newStart = parseInt(m[3], 10);
      const newCount = m[4] ? parseInt(m[4], 10) : 1;
      const context = (m[5] || "").trim(); // usually the enclosing fn/class
      current = {
        id: `${path}@${oldStart}:${newStart}`,
        file: path,
        header: line,
        context,
        oldStart,
        oldCount,
        newStart,
        newCount,
        body: [line], // include the @@ header as the first body line
        added: 0,
        removed: 0,
        newFile,
        deletedFile,
        renamedFile,
        op,
      };
    } else if (current) {
      current.body.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
      else if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
    }
    // lines before the first @@ (the ---/+++ file header) are dropped: the
    // file path is already captured on each hunk.
  }
  if (current) {
    current.contentHash = hashBody(current.body);
    hunks.push(current);
  }

  // No @@ hunks emitted. Two sub-cases, both represented as one synthetic chunk
  // so the file still shows up in the walk instead of silently vanishing:
  //   1. raw content but no @@ header (binary, or a whole-file add/delete blob)
  //   2. a metadata-only op (pure rename, or a rename/mode change with an empty
  //      diff) — previously dropped entirely, so the reviewer never saw it.
  if (!hunks.length && (raw.trim() || op)) {
    const oldPath = file.old_path && file.old_path !== path ? file.old_path : null;
    const summary =
      op === "renamed" && oldPath ? `renamed from ${oldPath}`
      : op === "renamed" ? "renamed"
      : op === "deleted" ? "file deleted"
      : op === "added" ? "file added"
      : "";
    const body = raw.trim() ? lines : [`@@ ${path} @@`, summary || "(no content change)"];
    hunks.push({
      id: `${path}@0:0`,
      file: path,
      header: `@@ ${path} @@`,
      context: summary,
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      // For a metadata-only op there's no diff text — seed the body with a
      // one-line human summary so the hunk pane isn't blank.
      body,
      added: (raw.match(/^\+/gm) || []).length,
      removed: (raw.match(/^-/gm) || []).length,
      newFile,
      deletedFile,
      renamedFile,
      op,
      contentHash: hashBody(body),
    });
  }
  return hunks;
}

// Flatten all files into a single ordered chunk list.
export function parseChanges(changes) {
  const chunks = [];
  for (const f of changes) {
    for (const h of parseFileHunks(f)) chunks.push(h);
  }
  return chunks;
}
