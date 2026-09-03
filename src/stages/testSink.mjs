// testSink stage — de-prioritise test files.
// Tests rarely carry business risk and crowd the top of the walk when a large MR
// touches both tests and production code. Sink them with a heavy penalty so they
// appear after all production chunks but are still reachable.

export default function create(params) {
  const penalty = params.penalty ?? 1000;
  return function stage(chunk, _ctx) {
    return chunk.isTest ? -penalty : 0;
  };
}

export const meta = {
  name: "testSink",
  params: {
    penalty: { type: "number", default: 1000 },
  },
};
