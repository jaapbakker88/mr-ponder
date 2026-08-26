// risk.mjs — score each chunk by "blast radius" so the walk can go risk-first.
//
// Signal: does the chunk's file live under a shared module, and if so, how many
// other modules import that file? High fan-out = a change here ripples widely =
// read it while fresh. Reuses the same @/-alias import grep as the mrs tool.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// A file is "shared" when it lives in a TOP-LEVEL shared dir (app/src/hooks/…,
// app/src/components/…), not a feature-local one (…/features/x/components/…).
// Feature-local dirs named "components"/"hooks" are not a wide blast radius.
export const SHARED_RE =
  /(?:^|\/)app\/src\/(components|hooks|services|lib|utils|providers|layouts|constants|types)\//;
export const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

// app/src/services/utils.ts -> @/services/utils
function importSpec(path) {
  const m = path.match(/(?:^|\/)app\/src\/(.+)$/) || path.match(/^src\/(.+)$/);
  if (!m) return null;
  return "@/" + m[1].replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
}

async function fanOut(spec, repoDir) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `from ['"]${escaped}['"/]`;
  try {
    const { stdout } = await execFileP(
      "bash",
      [
        "-c",
        `grep -rlE ${JSON.stringify(pattern)} app/src --include='*.ts' --include='*.tsx' 2>/dev/null | wc -l`,
      ],
      { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

// Annotate every chunk with { shared, isTest, fanOut, risk }. fanOut is computed
// once per distinct file (cached) to avoid repeated greps. `risk` is a sortable
// score: shared files weighted by fan-out, tests deprioritized.
export async function scoreChunks(chunks, repoDir) {
  const fanCache = new Map();
  for (const c of chunks) {
    const shared = SHARED_RE.test(c.file);
    const isTest = TEST_RE.test(c.file);
    let fan = 0;
    if (shared && !isTest) {
      const spec = importSpec(c.file);
      if (spec) {
        if (!fanCache.has(spec)) fanCache.set(spec, await fanOut(spec, repoDir));
        fan = fanCache.get(spec);
      }
    }
    c.shared = shared;
    c.isTest = isTest;
    c.fanOut = fan;
    // Risk score: fan-out dominates; a shared file with no importers still beats
    // a leaf; tests sink to the bottom; bigger hunks nudge up slightly.
    c.risk =
      (isTest ? -1000 : 0) +
      fan * 10 +
      (shared ? 50 : 0) +
      Math.min(c.added + c.removed, 100) / 10;
  }
  return chunks;
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
