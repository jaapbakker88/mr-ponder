// sizeTiebreak stage — break score ties by diff size.
// Capped and divided so the maximum contribution (+10) stays well below any
// other stage's typical delta. Purpose: when two chunks have identical scores on
// all other signals, larger ones surface first.

export default function create(params) {
  const cap = params.cap ?? 100;
  const divisor = params.divisor ?? 10;
  return function stage(chunk, _ctx) {
    return Math.min(chunk.added + chunk.removed, cap) / divisor;
  };
}

export const meta = {
  name: "sizeTiebreak",
  params: {
    cap: { type: "number", default: 100 },
    divisor: { type: "number", default: 10 },
  },
};
