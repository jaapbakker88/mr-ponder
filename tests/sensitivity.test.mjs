// Tests for sensitivity.mjs — the path-based risk overlay + its default rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sensitivity, DEFAULT_RULES, loadRules } from "../src/sensitivity.mjs";

// Use an explicit rule set so tests don't depend on a user's ~/.config file.
const rules = [
  { pattern: "(?:^|/)auth/", weight: 500, label: "auth" },
  { pattern: "(?:^|/)billing/", weight: 450, label: "money" },
  { pattern: "\\.sql$", weight: 300, label: "sql" },
].map((r) => ({ re: new RegExp(r.pattern, "i"), weight: r.weight, label: r.label }));

test("matches a sensitive path and returns weight + label", () => {
  const { weight, labels } = sensitivity("app/src/auth/guard.ts", rules);
  assert.equal(weight, 500);
  assert.deepEqual(labels, ["auth"]);
});

test("non-sensitive path scores zero", () => {
  const { weight, labels } = sensitivity("app/src/features/x/Leaf.tsx", rules);
  assert.equal(weight, 0);
  assert.deepEqual(labels, []);
});

test("multiple matching rules sum weights and collect labels", () => {
  const multi = [
    ...rules,
    { re: /migrate/i, weight: 450, label: "migration" },
  ];
  const { weight, labels } = sensitivity("db/billing/migrate_2026.sql", multi);
  // billing (450) + sql (300) + migration (450)
  assert.equal(weight, 1200);
  assert.deepEqual(labels.sort(), ["migration", "money", "sql"]);
});

test("matching is case-insensitive", () => {
  const { weight } = sensitivity("APP/SRC/AUTH/Guard.ts", rules);
  assert.equal(weight, 500);
});

test("DEFAULT_RULES flag common high-consequence leaf paths", () => {
  const compiled = DEFAULT_RULES.map((r) => ({
    re: new RegExp(r.pattern, "i"), weight: r.weight, label: r.label,
  }));
  const hit = (p) => sensitivity(p, compiled).labels;
  assert.ok(hit("app/src/features/checkout/auth/verify.ts").includes("auth"));
  assert.ok(hit("app/src/services/payment/charge.ts").includes("money"));
  assert.ok(hit("db/migrations/0007_add_col.sql").length > 0);
  assert.ok(hit(".gitlab-ci.yml").includes("infra"));
  assert.ok(hit("infra/terraform/main.tf").includes("infra"));
});

test("loadRules returns a non-empty compiled rule set (defaults when no config)", () => {
  const r = loadRules(true);
  assert.ok(Array.isArray(r));
  assert.ok(r.length > 0);
  assert.ok(r[0].re instanceof RegExp);
});
