// depssort.mjs — intra-MR dependency sort.
//
// Builds a directed import graph restricted to the MR's changed files and
// topologically sorts them so foundations (types, utilities, services) appear
// before the components and pages that consume them.
//
// Import extraction replicates the `fileImports` pattern from suggest.mjs.
// When SPEC-project-model.md lands, both will be replaced by
// `profile.importsOf(text)` so this stays in sync by design, not accident.
//
// When SPEC-import-graph.md Part A lands, `buildIntraEdges` can be replaced
// by a simple intersection of `graph.byFile` with the changed-file set —
// same return shape, no behavior change.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { importSpec, TEST_RE } from "./paths.mjs";

// Extract @/ import specs from a file's text. Mirrors the logic in
// suggest.mjs:fileImports — kept in sync manually until profile lands.
function extractImports(text, ignoreRemoved = false) {
  const specs = new Set();
  for (const line of text.split("\n")) {
    if (ignoreRemoved && line.startsWith("-")) continue;
    const m = line.match(/from\s+['"](@\/[^'"]+)['"]/);
    if (m) specs.add(m[1].replace(/\/index$/, ""));
  }
  return specs;
}

async function fileImports(path, repoDir, diffByFile) {
  try {
    if (!repoDir) throw new Error("no repoDir");
    const src = await readFile(join(repoDir, path), "utf8");
    return extractImports(src, false);
  } catch {
    // Not on disk (new file or branch not checked out) — use the diff window.
    const diff = diffByFile?.get(path) || "";
    return extractImports(diff, true);
  }
}

// Build directed file-level edges: edges.get(A) = Set of MR files that A imports.
// "A imports B" means B should be read before A.
// Returns a Map<path, Set<path>> for every changed file.
export async function buildIntraEdges(chunks, repoDir, diffByFile) {
  const files = [...new Set(chunks.map((c) => c.file))];

  const specOf = new Map();  // file -> its own @/ module spec (what it exports as)
  const imports = new Map(); // file -> Set<@/ spec> (what it imports)

  await Promise.all(
    files.map(async (f) => {
      specOf.set(f, importSpec(f));
      imports.set(f, await fileImports(f, repoDir, diffByFile));
    }),
  );

  // Invert specOf so we can resolve a spec back to the MR file that owns it.
  const specToFile = new Map();
  for (const [f, s] of specOf) {
    if (s) specToFile.set(s, f);
  }

  // edges[A] = set of MR files that A imports (A's in-MR dependencies).
  const edges = new Map(files.map((f) => [f, new Set()]));
  for (const [A, importedSpecs] of imports) {
    for (const spec of importedSpecs) {
      const B = specToFile.get(spec);
      if (B && B !== A) edges.get(A).add(B);
    }
  }
  return edges;
}

// Topological sort of MR files: foundations (no in-MR imports) first, consumers
// last. Test files are always appended after the topo order regardless of edges.
//
// Returns an ordered array of file paths, or null if there are no intra-MR
// import edges (caller should fall back to file order in that case).
export function depsOrder(files, edges) {
  const tests = files.filter((f) => TEST_RE.test(f));
  const nonTests = files.filter((f) => !TEST_RE.test(f));
  const nonTestSet = new Set(nonTests);

  // inDeg[A] = number of non-test MR files that A imports (A's dependency count).
  // A file with inDeg 0 has no in-MR dependencies — it is a foundation.
  const inDeg = new Map(nonTests.map((f) => [f, 0]));
  // after[B] = set of non-test MR files that import B (must come after B).
  const after = new Map(nonTests.map((f) => [f, new Set()]));

  for (const A of nonTests) {
    for (const B of (edges.get(A) ?? [])) {
      if (!nonTestSet.has(B)) continue;
      inDeg.set(A, inDeg.get(A) + 1);
      after.get(B).add(A);
    }
  }

  // No intra-MR edges at all — signal to caller to fall back.
  if (![...inDeg.values()].some((d) => d > 0)) return null;

  // Kahn's algorithm: emit foundations (inDeg 0) first, reduce dependents.
  const queue = nonTests.filter((f) => inDeg.get(f) === 0);
  const result = [];
  while (queue.length > 0) {
    const f = queue.shift();
    result.push(f);
    for (const dependent of after.get(f)) {
      const d = inDeg.get(dependent) - 1;
      inDeg.set(dependent, d);
      if (d === 0) queue.push(dependent);
    }
  }

  // Append any cycle participants in their original order.
  const resultSet = new Set(result);
  for (const f of nonTests) {
    if (!resultSet.has(f)) result.push(f);
  }

  return [...result, ...tests];
}
