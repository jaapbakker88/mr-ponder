// diff.mjs — parse GitLab's unified per-file diffs into individual hunks.
//
// A "chunk" here == one @@ hunk of one file, the same unit `git add -p` walks.
// Each chunk gets a STABLE id (file + old/new start lines) so notes re-attach
// correctly after a re-fetch, as long as the hunk didn't move.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Split one file's `diff` string into hunk objects.
export function parseFileHunks(file) {
  const path = file.new_path || file.old_path || "";
  const raw = file.diff || "";
  const lines = raw.split("\n");

  const hunks = [];
  let current = null;

  for (const line of lines) {
    const m = line.match(HUNK_RE);
    if (m) {
      if (current) hunks.push(current);
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
        newFile: !!file.new_file,
        deletedFile: !!file.deleted_file,
        renamedFile: !!file.renamed_file,
      };
    } else if (current) {
      current.body.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
      else if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
    }
    // lines before the first @@ (the ---/+++ file header) are dropped: the
    // file path is already captured on each hunk.
  }
  if (current) hunks.push(current);

  // A pure add/delete with no @@ (e.g. binary) yields no hunks — represent the
  // whole file as one synthetic chunk so it still shows up in the walk.
  if (!hunks.length && raw.trim()) {
    hunks.push({
      id: `${path}@0:0`,
      file: path,
      header: `@@ ${path} @@`,
      context: "",
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      body: lines,
      added: (raw.match(/^\+/gm) || []).length,
      removed: (raw.match(/^-/gm) || []).length,
      newFile: !!file.new_file,
      deletedFile: !!file.deleted_file,
      renamedFile: !!file.renamed_file,
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
