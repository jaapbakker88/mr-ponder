// authorship stage — "few-author" risk signal.
//
// Fewer distinct authors = fewer people who know this file well = higher
// risk when it changes.  Formula: weight / (authorCount + 1), so:
//   0 authors in window → weight/1 = full weight (new/unmaintained)
//   1 author            → weight/2
//   9 authors           → weight/10
//   ∞ authors           → → 0
//
// Degrades to 0 when repoDir is absent (null signal).

export default function create(params) {
  const weight = params.weight ?? 40;
  return function stage(_chunk, ctx) {
    if (ctx.authorCount === null) return 0;
    return weight / (ctx.authorCount + 1);
  };
}

export const meta = {
  name: "authorship",
  params: {
    weight: { type: "number", default: 40 },
  },
};
