// sharedBonus stage — nudge up shared-module files.
// Shared files are imported across feature boundaries; any change there has
// broader reach than a leaf, even before fan-out is measured.

export default function create(params) {
  const bonus = params.bonus ?? 50;
  return function stage(chunk, _ctx) {
    return chunk.shared ? bonus : 0;
  };
}

export const meta = {
  name: "sharedBonus",
  params: {
    bonus: { type: "number", default: 50 },
  },
};
