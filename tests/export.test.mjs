// Tests for export.mjs — the structured review artifact (json object + markdown).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExport, toMarkdown } from "../src/export.mjs";

const chunk = (id, file, extra = {}) => ({
  id, file, risk: 0, added: 1, removed: 0, fanOut: 0,
  shared: false, unknown: false, isTest: false, sensLabels: [], ...extra,
});

const state = () => ({
  project: "g/p", iid: 7, headSha: "abc",
  seen: {}, engaged: {}, notes: {}, tags: {}, links: [],
});

test("buildExport includes only annotated chunks by default", () => {
  const chunks = [
    chunk("a@1:1", "app/src/x.ts"),
    chunk("b@2:2", "app/src/y.ts"),
  ];
  const s = state();
  s.notes["a@1:1"] = [{ text: "look here", at: "t" }];
  const ex = buildExport(s, chunks, { iid: 7 });
  assert.equal(ex.schema, "mrp.export/1");
  assert.equal(ex.findings.length, 1);
  assert.equal(ex.findings[0].chunk, "a@1:1");
  assert.equal(ex.findings[0].notes[0].text, "look here");
});

test("buildExport all:true includes every chunk with risk", () => {
  const chunks = [chunk("a@1:1", "x.ts", { risk: 500 }), chunk("b@2:2", "y.ts")];
  const ex = buildExport(state(), chunks, { iid: 7 }, { all: true });
  assert.equal(ex.findings.length, 2);
  assert.equal(ex.findings[0].risk, 500);
});

test("buildExport summary counts are accurate", () => {
  const chunks = [
    chunk("a@1:1", "x.ts", { sensLabels: ["auth"] }),
    chunk("b@2:2", "y.ts", { unknown: true }),
    chunk("c@3:3", "z.ts"),
  ];
  const s = state();
  s.seen["a@1:1"] = true;
  s.engaged["a@1:1"] = true;
  s.tags["b@2:2"] = ["risky"];
  s.links.push({ from: "a@1:1", to: "c@3:3", label: "related" });
  const ex = buildExport(s, chunks, { iid: 7 });
  assert.equal(ex.summary.chunks, 3);
  assert.equal(ex.summary.sensitiveChunks, 1);
  assert.equal(ex.summary.unknownChunks, 1);
  assert.equal(ex.summary.links, 1);
});

test("buildExport emits each link once (from side only)", () => {
  const chunks = [chunk("a@1:1", "x.ts"), chunk("b@2:2", "y.ts")];
  const s = state();
  s.links.push({ from: "a@1:1", to: "b@2:2", label: "rel" });
  const ex = buildExport(s, chunks, { iid: 7 });
  const a = ex.findings.find((f) => f.chunk === "a@1:1");
  const b = ex.findings.find((f) => f.chunk === "b@2:2");
  assert.equal(a.links.length, 1);
  assert.equal(b.links.length, 0); // not double-counted on the to-side
});

test("toMarkdown renders a header, summary and findings", () => {
  const chunks = [chunk("a@1:1", "app/src/auth/x.ts", { sensLabels: ["auth"], risk: 500 })];
  const s = state();
  s.notes["a@1:1"] = [{ text: "possible bypass", at: "t" }];
  const md = toMarkdown(buildExport(s, chunks, { iid: 7 }));
  assert.match(md, /# Review of !7/);
  assert.match(md, /auth/);
  assert.match(md, /possible bypass/);
  assert.match(md, /app\/src\/auth\/x\.ts/);
});

test("toMarkdown handles an empty review", () => {
  const md = toMarkdown(buildExport(state(), [chunk("a@1:1", "x.ts")], { iid: 7 }));
  assert.match(md, /No annotated findings/);
});
