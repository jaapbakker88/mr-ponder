// paths.mjs — shared path/module helpers used by both risk scoring and link
// suggestion. Single source of truth so the "what counts as shared" and
// "how a file maps to its @/ import spec" rules can't drift between modules.

// A file is "shared" when it lives in a TOP-LEVEL shared dir (app/src/hooks/…,
// app/src/components/…), not a feature-local one (…/features/x/components/…).
// Feature-local dirs named "components"/"hooks" are not a wide blast radius.
export const SHARED_RE =
  /(?:^|\/)app\/src\/(components|hooks|services|lib|utils|providers|layouts|constants|types)\//;

export const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

// app/src/services/utils.ts -> @/services/utils
export function importSpec(path) {
  const m = path.match(/(?:^|\/)app\/src\/(.+)$/) || path.match(/^src\/(.+)$/);
  if (!m) return null;
  return "@/" + m[1].replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
}
