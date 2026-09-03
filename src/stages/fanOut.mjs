// fanOut stage — log-dampened import reach.
//
// Formula: min(log10(fan+1) * multiplier, cap)
// fan=0 → 0 (log10(1)=0); fan=1 → ~35; fan=10 → ~120; fan=100 → ~230; cap=300.
// Only shared non-test files ever have fan > 0; all others receive ctx.fanOut = 0
// from the runner, so this stage naturally contributes 0 for leaf files.

export default function create(params) {
  const multiplier = params.multiplier ?? 115;
  const cap = params.cap ?? 300;
  return function stage(_chunk, ctx) {
    const fan = ctx.fanOut ?? 0;
    return Math.min(Math.log10(fan + 1) * multiplier, cap);
  };
}

export const meta = {
  name: "fanOut",
  params: {
    multiplier: { type: "number", default: 115 },
    cap: { type: "number", default: 300 },
  },
};
