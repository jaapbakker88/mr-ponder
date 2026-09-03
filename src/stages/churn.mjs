// churn stage — log-dampened commit frequency in the configured window.
//
// A file touched frequently is actively evolving; bugs introduced there are
// more likely to be fresh. Requires repoDir; degrades to 0 when absent
// (ctx.churn === null).
//
// The `window` param controls how many days the git fetcher looks back.
// It is read by the pipeline runner to configure the fetch, not by this
// function — the stage itself only reads the pre-fetched ctx.churn value.

export default function create(params) {
  const weight = params.weight ?? 80;
  return function stage(_chunk, ctx) {
    if (ctx.churn === null) return 0;
    return Math.log10(ctx.churn + 1) * weight;
  };
}

export const meta = {
  name: "churn",
  params: {
    weight: { type: "number", default: 80 },
    window: { type: "number", default: 90, description: "days; consumed by the git fetcher" },
  },
};
