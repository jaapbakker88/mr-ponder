// sensitivity.mjs — path-based risk overlay.
//
// Blast radius (import fan-out) answers "how many files could this affect?".
// It does NOT answer "how badly does a defect here hurt?". The changes that slip
// through review of AI-generated MRs are usually LEAF files: auth checks, money
// math, migrations, deletes, PII, infra/flags/CI — low or zero fan-out, yet high
// consequence. This overlay lets those paths sort read-first regardless of
// fan-out, and is org-configurable so the threat model lives in data, not code.
//
// Config: ~/.config/mrp/sensitivity.json — an array of rules:
//   [{ "pattern": "regex source", "weight": 400, "label": "auth" }, ...]
// Absent config → DEFAULT_RULES below (works out of the box; override to tune).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "mrp", "sensitivity.json");
}

// Weights are deliberately large relative to fan-out*10 (see risk.mjs) so a
// sensitive leaf file outranks a widely-imported-but-mundane one. Ordered
// high→low by consequence; a file can match several rules (weights sum).
export const DEFAULT_RULES = [
  { pattern: "(?:^|/)(auth|authz|authorization|permission|rbac|acl|session|token|oauth|saml|sso|login|password|crypto|secret)s?/", weight: 500, label: "auth" },
  { pattern: "(?:^|/)(billing|payment|invoice|charge|refund|price|pricing|tax|money|currency|ledger|payout)s?/", weight: 450, label: "money" },
  { pattern: "(?:^|/)(migration|migrate)s?/", weight: 450, label: "migration" },
  { pattern: "\\.(sql)$", weight: 300, label: "sql" },
  { pattern: "(?:^|/)(pii|gdpr|personal|ssn|dob)", weight: 400, label: "pii" },
  { pattern: "\\bdelete|\\bdrop\\b|truncate|purge|destroy", weight: 250, label: "destructive" },
  { pattern: "(?:^|/)(policy|policies|iam)(?:/|\\.)", weight: 350, label: "policy" },
  { pattern: "(?:^|/)(\\.env|Dockerfile|docker-compose|\\.gitlab-ci|Jenkinsfile|terraform|\\.tf|helm|k8s|kubernetes)", weight: 350, label: "infra" },
  { pattern: "(?:^|/)(feature[-_]?flag|flags?)(?:/|\\.)", weight: 200, label: "flag" },
  { pattern: "(?:^|/)(webhook|callback|redirect)s?", weight: 200, label: "external-entry" },
];

let cached = null; // { rules: [{re, weight, label}] }

// Compile an array of raw rule objects into [{re, weight, label}]. Bad regexes are
// skipped with a warning rather than crashing the walk — a typo in one org rule
// shouldn't blind the tool. Called by loadRules() and by pipeline.mjs when the
// active config supplies its own sensitivityRules array.
export function compileRules(raw) {
  const rules = [];
  for (const r of raw) {
    if (!r || typeof r.pattern !== "string") continue;
    try {
      rules.push({ re: new RegExp(r.pattern, "i"), weight: Number(r.weight) || 0, label: String(r.label || "sensitive") });
    } catch {
      process.stderr.write(`mrp: skipping invalid sensitivity pattern: ${r.pattern}\n`);
    }
  }
  return rules;
}

// Load (and cache) rules from config file or defaults.
export function loadRules(forceReload = false) {
  if (cached && !forceReload) return cached.rules;
  let raw = DEFAULT_RULES;
  const p = configPath();
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(parsed)) raw = parsed;
    } catch {
      process.stderr.write(`mrp: ignoring malformed ${p}\n`);
    }
  }
  const rules = compileRules(raw);
  cached = { rules };
  return rules;
}

// Score a file path against the rules. Returns { weight, labels }. A path can
// match several rules; weights sum and labels concatenate (dedup, order-stable).
export function sensitivity(file, rules = loadRules()) {
  let weight = 0;
  const labels = [];
  for (const r of rules) {
    if (r.re.test(file)) {
      weight += r.weight;
      if (!labels.includes(r.label)) labels.push(r.label);
    }
  }
  return { weight, labels };
}
