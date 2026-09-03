// recency stage — step-function penalty for stale files.
//
// A file untouched for a long time that suddenly changes is a higher-risk
// event than a routine edit to an actively-maintained file — the author may
// be less familiar with its current state, or the change may be unplanned.
//
// Returns `weight` when the file hasn't been touched in >= staleDays days;
// 0 otherwise.  Degrades to 0 when repoDir is absent (null signal).

export default function create(params) {
  const weight    = params.weight    ?? 60;
  const staleDays = params.staleDays ?? 180;
  return function stage(_chunk, ctx) {
    if (ctx.lastTouchedDaysAgo === null) return 0;
    return ctx.lastTouchedDaysAgo >= staleDays ? weight : 0;
  };
}

export const meta = {
  name: "recency",
  params: {
    weight:    { type: "number", default: 60 },
    staleDays: { type: "number", default: 180 },
  },
};
