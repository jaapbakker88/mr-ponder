// metaOnlySink stage — de-prioritise metadata-only moves/deletes.
// A rename or delete with zero added/removed lines has no code to review (the
// diff is empty). Sink it below production files. Content-bearing renames score
// normally via chunk.metaOnly = false.

export default function create(params) {
  const penalty = params.penalty ?? 900;
  return function stage(chunk, _ctx) {
    return chunk.metaOnly ? -penalty : 0;
  };
}

export const meta = {
  name: "metaOnlySink",
  params: {
    penalty: { type: "number", default: 900 },
  },
};
