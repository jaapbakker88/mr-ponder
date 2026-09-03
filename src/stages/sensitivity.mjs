// sensitivity stage — returns the pre-computed path-sensitivity weight from ctx.
// The runner computes ctx.sensitivity for every chunk (required for display even
// when this stage is not in the pipeline), so this is a pure pass-through.

export default function create(_params) {
  return function stage(_chunk, ctx) {
    return ctx.sensitivity ?? 0;
  };
}

export const meta = {
  name: "sensitivity",
  params: {},
};
