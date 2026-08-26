// suggest.mjs — rank candidate chunks to link FROM a given chunk.
//
// Three structural signals, all derived without asking the user to remember
// anything:
//   1. same-file   — other hunks in the same file (adjacent logic).
//   2. same-tag    — chunks the user already tagged with a shared tag.
//   3. import-edge — this chunk changes a shared module @/x, and the candidate's
//                    file imports @/x (or vice-versa): a producer/consumer pair.
//
// import-edges are precomputed once per session (they need the local repo to
// read each changed file's own import list).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importSpec } from "./paths.mjs";

// Read the @/ specifiers a given repo file imports (best-effort). Prefer the
// local checkout (complete import list), but the MR branch may not be checked
// out locally — so fall back to the imports visible in the file's own diff
// (context + added lines). The diff fallback undercounts (imports above the
// changed hunks aren't in the window) but never errors on a missing file.
async function fileImports(path, repoDir, diffByFile) {
  const specs = new Set();
  const collect = (text, ignoreRemoved) => {
    for (const line of text.split("\n")) {
      if (ignoreRemoved && line.startsWith("-")) continue;
      const m = line.match(/from\s+['"](@\/[^'"]+)['"]/);
      if (m) specs.add(m[1].replace(/\/index$/, ""));
    }
  };
  try {
    const src = await readFile(join(repoDir, path), "utf8");
    collect(src, false);
  } catch {
    // Not on disk (new file / branch not checked out) — use the diff window.
    const diff = diffByFile?.get(path) || "";
    collect(diff, true);
  }
  return specs;
}

// Build an undirected edge set between chunk ids whose files sit in a
// producer/consumer import relationship. Returns Map<chunkId, Set<chunkId>>.
// `diffByFile` (Map<path, diffString>) powers the no-checkout fallback.
export async function buildImportEdges(chunks, repoDir, diffByFile) {
  // Distinct files in the diff, each with its own module spec + import list.
  const files = [...new Set(chunks.map((c) => c.file))];
  const spec = new Map(); // file -> its own @/ module spec (what it EXPORTS as)
  const imports = new Map(); // file -> Set of @/ specs it IMPORTS
  await Promise.all(
    files.map(async (f) => {
      spec.set(f, importSpec(f));
      imports.set(f, await fileImports(f, repoDir, diffByFile));
    }),
  );

  // file A -> file B if B imports A's module spec (A is a dependency of B).
  const fileEdges = new Map(); // file -> Set<file>
  const add = (a, b) => {
    if (a === b) return;
    (fileEdges.get(a) || fileEdges.set(a, new Set()).get(a)).add(b);
    (fileEdges.get(b) || fileEdges.set(b, new Set()).get(b)).add(a);
  };
  for (const a of files) {
    const aSpec = spec.get(a);
    if (!aSpec) continue;
    for (const b of files) {
      if (a === b) continue;
      if (imports.get(b)?.has(aSpec)) add(a, b);
    }
  }

  // Lift file-edges to chunk-edges (every hunk of A relates to every hunk of B).
  const byFile = new Map();
  for (const c of chunks) (byFile.get(c.file) || byFile.set(c.file, []).get(c.file)).push(c);
  const edges = new Map();
  const link = (x, y) => {
    (edges.get(x) || edges.set(x, new Set()).get(x)).add(y);
    (edges.get(y) || edges.set(y, new Set()).get(y)).add(x);
  };
  for (const [a, bs] of fileEdges) {
    for (const b of bs) {
      for (const ca of byFile.get(a) || [])
        for (const cb of byFile.get(b) || []) link(ca.id, cb.id);
    }
  }
  return edges;
}

// Rank link candidates for `chunk`, given all chunks, current state (tags/links),
// and the precomputed import-edge map. Excludes self and already-linked targets.
export function suggestLinks(chunk, chunks, state, importEdges, limit = 6) {
  if (!chunk) return [];
  const already = new Set(
    (state.links || [])
      .filter((l) => l.from === chunk.id || l.to === chunk.id)
      .map((l) => (l.from === chunk.id ? l.to : l.from)),
  );
  const myTags = new Set(state.tags?.[chunk.id] || []);
  const edgeSet = importEdges.get(chunk.id) || new Set();

  const scored = new Map(); // id -> { chunk, score, reasons[] }
  const bump = (c, pts, reason) => {
    if (c.id === chunk.id || already.has(c.id)) return;
    const e = scored.get(c.id) || { chunk: c, score: 0, reasons: [] };
    e.score += pts;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    scored.set(c.id, e);
  };

  for (const c of chunks) {
    if (c.file === chunk.file) bump(c, 2, "same file");
    if (edgeSet.has(c.id)) bump(c, 5, "import edge");
    const shared = (state.tags?.[c.id] || []).filter((t) => myTags.has(t));
    if (shared.length) bump(c, 3 + shared.length, `#${shared[0]}`);
  }

  return [...scored.values()]
    .sort((a, z) => z.score - a.score || a.chunk.file.localeCompare(z.chunk.file))
    .slice(0, limit);
}
