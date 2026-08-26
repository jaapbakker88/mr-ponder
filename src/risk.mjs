// risk.mjs — score each chunk by "blast radius" so the walk can go risk-first.
//
// Signal: does the chunk's file live under a shared module, and if so, how many
// other modules import that file? High fan-out = a change here ripples widely =
// read it while fresh. Reuses the same @/-alias import grep as the mrs tool.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SHARED_RE, TEST_RE, importSpec } from "./paths.mjs";
import { sensitivity, loadRules } from "./sensitivity.mjs";

const execFileP = promisify(execFile);

// Re-exported for callers that historically imported these from risk.mjs.
export { SHARED_RE, TEST_RE };

// How many modules import `spec` — the file's blast radius. Uses ripgrep
// directly (no shell). Returns { count, failed }: rg exit 1 means "no matches"
// (a genuine fan-out of 0), exit 2 (or rg missing / path absent) means we could
// NOT assess it — surfaced as failed:true so the caller can fail loud instead of
// treating an un-measurable file as low-risk.
async function fanOut(spec, repoDir) {
  const escaped = spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `from ['"]${escaped}['"/]`;
  try {
    const { stdout } = await execFileP(
      "rg",
      ["-l", "-e", pattern, "-g", "*.ts", "-g", "*.tsx", "app/src"],
      { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 },
    );
    return { count: stdout.split("\n").filter(Boolean).length, failed: false };
  } catch (e) {
    // rg exit 1 = no matches (real 0, assessed). Anything else (exit 2, ENOENT,
    // missing dir) = we couldn't assess this file's reach.
    if (e && e.code === 1) return { count: 0, failed: false };
    return { count: 0, failed: true };
  }
}

// Annotate every chunk with { shared, isTest, fanOut, sensitivity, sensLabels,
// unknown, risk }. fanOut is computed once per distinct file (cached) and in
// parallel. `risk` combines a path-SENSITIVITY overlay (dominant: consequence of a
// defect here — auth/money/migrations/infra sort read-first regardless of fan-out),
// blast radius (fan-out), and an UNKNOWN nudge so unassessable shared files sort UP
// rather than silently sinking. Tests are deprioritized.
export async function scoreChunks(chunks, repoDir) {
  const rules = loadRules();
  // Compute fan-out once per distinct shared module spec, in parallel — a big
  // MR can touch many shared files, and each fanOut is an independent repo grep.
  const specs = [
    ...new Set(
      chunks
        .filter((c) => SHARED_RE.test(c.file) && !TEST_RE.test(c.file))
        .map((c) => importSpec(c.file))
        .filter(Boolean),
    ),
  ];
  const fans = await Promise.all(specs.map((s) => fanOut(s, repoDir)));
  const fanCache = new Map(specs.map((s, i) => [s, fans[i]]));

  for (const c of chunks) {
    const shared = SHARED_RE.test(c.file);
    const isTest = TEST_RE.test(c.file);
    let fan = 0;
    // "unknown" = a shared file whose blast radius we could NOT measure (the
    // fan-out grep failed: branch not checked out, rg missing, etc.). Fail loud:
    // nudge it UP — "couldn't assess" is a reason to look, not to skip. A real
    // measured 0 is NOT unknown.
    let unknown = false;
    if (shared && !isTest) {
      const spec = importSpec(c.file);
      if (spec) {
        const r = fanCache.get(spec);
        fan = r ? r.count : 0;
        unknown = r ? r.failed : true; // no spec resolved OR grep failed
      } else {
        unknown = true;
      }
    }
    const { weight: sens, labels: sensLabels } = sensitivity(c.file, rules);
    c.shared = shared;
    c.isTest = isTest;
    c.fanOut = fan;
    c.sensitivity = sens;
    c.sensLabels = sensLabels;
    c.unknown = unknown;
    // Risk score. Consequence (sensitivity) is categorical and DOMINATES; reach
    // (fan-out) has diminishing returns — importer #117 tells you little more than
    // #40 did — so it's log-dampened and capped, ensuring no amount of mundane
    // reach outranks a high-consequence path. A shared file still beats a leaf;
    // unknown shared files get a fail-loud nudge; tests sink; size breaks ties.
    //   fanScore: 0→0, 1→~35, 10→~120, 100→~230, 1000→~350 (cap 300 below)
    const fanScore = Math.min(fan > 0 ? Math.log10(fan + 1) * 115 : 0, 300);
    c.risk =
      (isTest ? -1000 : 0) +
      sens +
      fanScore +
      (shared ? 50 : 0) +
      (unknown ? 75 : 0) +
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

// Presentation order for the walk + sidebar (they MUST share one ordering or the
// cursor "teleports"). Input is assumed risk-sorted.
//   "risk": unchanged — flat, highest-consequence first.
//   "file": grouped by file (files ordered by their riskiest chunk = first
//           occurrence in the risk-sorted input), chunks within a file top-to-bottom.
export function orderChunks(chunks, mode) {
  if (mode !== "file") return [...chunks];
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
