// unknownBonus stage — fail-loud nudge for files whose blast radius is unassessable.
//
// When fan-out computation fails (rg missing, branch not checked out, path absent),
// ctx.fanOutFailed is true. "Couldn't assess" is a reason to read a file, not to
// skip it. A measured fan-out of 0 (genuine leaf) does NOT trigger this.

export default function create(params) {
  const bonus = params.bonus ?? 75;
  return function stage(_chunk, ctx) {
    return ctx.fanOutFailed ? bonus : 0;
  };
}

export const meta = {
  name: "unknownBonus",
  params: {
    bonus: { type: "number", default: 75 },
  },
};
