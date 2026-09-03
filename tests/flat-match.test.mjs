// flat-match.test.mjs — unit tests for the flat match index logic introduced
// in the n/N search-navigation redesign (TICKET-task-search-flat-index).
//
// The logic lives inside React useMemo/handlers in ui.mjs; these tests exercise
// equivalent pure functions directly so we don't need to mount the Ink component.

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers that mirror the ui.mjs logic exactly
// ---------------------------------------------------------------------------

// Mirrors compilePattern() in ui.mjs.
function compilePattern(raw) {
  try {
    const re = new RegExp(raw, "i");
    return { test: (s) => re.test(s) };
  } catch {
    const needle = raw.toLowerCase();
    return { test: (s) => s.toLowerCase().includes(needle) };
  }
}

// Mirrors the flatMatches useMemo in ui.mjs.
function buildFlatMatches(visible, pattern) {
  if (!pattern) return [];
  const p = compilePattern(pattern);
  const matches = [];
  visible.forEach((c, chunkIdx) => {
    c.body.forEach((line, bodyIdx) => {
      if (bodyIdx === 0 || line.startsWith("-")) return;
      if (p.test(line)) matches.push({ chunkIdx, bodyIdx });
    });
  });
  return matches;
}

// Mirrors the scroll-centering math in the n/N handler.
function targetScroll(bodyIdx, bodyLen, bodyH) {
  return Math.max(0, Math.min(bodyIdx - Math.floor(bodyH / 2), Math.max(0, bodyLen - bodyH)));
}

// Mirrors the chunkMatchIdx derived value in ui.mjs.
function getChunkMatchIdx(flatMatches, flatMatchIdx, safeIdx) {
  if (flatMatches[flatMatchIdx]?.chunkIdx !== safeIdx) return 0;
  return flatMatches.filter((_, i) => flatMatches[i].chunkIdx === safeIdx && i < flatMatchIdx).length;
}

// ---------------------------------------------------------------------------
// buildFlatMatches
// ---------------------------------------------------------------------------

function makeChunk(bodyLines) {
  return { body: ["@@ -1 +1 @@", ...bodyLines] };
}

test("empty pattern → no matches", () => {
  const visible = [makeChunk([" context", "+added"])];
  assert.deepEqual(buildFlatMatches(visible, ""), []);
});

test("skips @@ header (body[0])", () => {
  const visible = [makeChunk([" no match here"])];
  // If pattern matches the @@ line it should still be skipped.
  const fake = [{ body: ["@@ match me @@", " other"] }];
  const matches = buildFlatMatches(fake, "match");
  assert.equal(matches.length, 0);
});

test("skips removed lines", () => {
  const visible = [makeChunk(["-removed line with pattern", "+added line with pattern"])];
  const matches = buildFlatMatches(visible, "pattern");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].bodyIdx, 2); // bodyIdx 1 = removed (skipped), bodyIdx 2 = added
});

test("matches added and context lines", () => {
  const visible = [makeChunk([" context with foo", "+added with foo", "-removed with foo"])];
  const matches = buildFlatMatches(visible, "foo");
  assert.equal(matches.length, 2);
  assert.equal(matches[0].bodyIdx, 1); // context
  assert.equal(matches[1].bodyIdx, 2); // added
});

test("spans multiple chunks, chunkIdx is correct", () => {
  const visible = [
    makeChunk([" no match", "+has TARGET"]),             // 1 match: bodyIdx 2
    makeChunk(["+TARGET here", " also TARGET here"]),    // 2 matches: bodyIdx 1, 2
    makeChunk([" nothing"]),                             // 0 matches
  ];
  const matches = buildFlatMatches(visible, "TARGET");
  assert.equal(matches.length, 3);
  assert.equal(matches[0].chunkIdx, 0);
  assert.equal(matches[0].bodyIdx, 2);
  assert.equal(matches[1].chunkIdx, 1);
  assert.equal(matches[1].bodyIdx, 1);
  assert.equal(matches[2].chunkIdx, 1);
  assert.equal(matches[2].bodyIdx, 2);
});

test("regex pattern works", () => {
  const visible = [makeChunk([" foo123", " bar456", " baz789"])];
  const matches = buildFlatMatches(visible, "\\d{3}");
  assert.equal(matches.length, 3);
});

test("case-insensitive matching", () => {
  const visible = [makeChunk([" Hello World"])];
  assert.equal(buildFlatMatches(visible, "hello").length, 1);
  assert.equal(buildFlatMatches(visible, "WORLD").length, 1);
});

test("invalid regex falls back to literal match", () => {
  const visible = [makeChunk([" cost is (100+tax)"])];
  // "(100+" is an invalid regex (unmatched parenthesis/quantifier) — should fall
  // back to literal substring search and still find the text.
  const matches = buildFlatMatches(visible, "(100+");
  assert.equal(matches.length, 1);
});

test("no matches → empty array", () => {
  const visible = [makeChunk([" nothing relevant", "+also nothing"])];
  assert.deepEqual(buildFlatMatches(visible, "zzznomatch"), []);
});

// ---------------------------------------------------------------------------
// targetScroll — centering math
// ---------------------------------------------------------------------------

test("targetScroll: match in the middle of a tall body → centered", () => {
  // bodyH=10, bodyLen=30, bodyIdx=15 → 15 - 5 = 10
  assert.equal(targetScroll(15, 30, 10), 10);
});

test("targetScroll: match near the top → clamped to 0", () => {
  // bodyIdx=2, bodyH=10 → 2-5 = -3 → clamped to 0
  assert.equal(targetScroll(2, 30, 10), 0);
});

test("targetScroll: match near the bottom → clamped to bodyLen-bodyH", () => {
  // bodyIdx=28, bodyH=10, bodyLen=30 → maxScroll=20; 28-5=23 → clamped to 20
  assert.equal(targetScroll(28, 30, 10), 20);
});

test("targetScroll: body fits on screen → always 0", () => {
  // bodyLen <= bodyH → maxScroll=0
  assert.equal(targetScroll(5, 8, 10), 0);
});

// ---------------------------------------------------------------------------
// Flat-index navigation arithmetic
// ---------------------------------------------------------------------------

test("n wraps from last match back to first", () => {
  const len = 5;
  const dir = 1;
  const cur = 4;
  const next = ((cur + dir) % len + len) % len;
  assert.equal(next, 0);
});

test("N wraps from first match to last", () => {
  const len = 5;
  const dir = -1;
  const cur = 0;
  const next = ((cur + dir) % len + len) % len;
  assert.equal(next, 4);
});

// ---------------------------------------------------------------------------
// chunkMatchIdx
// ---------------------------------------------------------------------------

test("chunkMatchIdx: first match in chunk → 0", () => {
  const fm = [
    { chunkIdx: 0, bodyIdx: 1 },
    { chunkIdx: 0, bodyIdx: 3 },
    { chunkIdx: 1, bodyIdx: 1 },
  ];
  assert.equal(getChunkMatchIdx(fm, 0, 0), 0);
});

test("chunkMatchIdx: second match in chunk → 1", () => {
  const fm = [
    { chunkIdx: 0, bodyIdx: 1 },
    { chunkIdx: 0, bodyIdx: 3 },
    { chunkIdx: 1, bodyIdx: 1 },
  ];
  assert.equal(getChunkMatchIdx(fm, 1, 0), 1);
});

test("chunkMatchIdx: flatMatchIdx points to different chunk → 0", () => {
  const fm = [
    { chunkIdx: 0, bodyIdx: 1 },
    { chunkIdx: 1, bodyIdx: 2 },
  ];
  // flatMatchIdx=1 (chunk 1), but safeIdx=0 → not in same chunk
  assert.equal(getChunkMatchIdx(fm, 1, 0), 0);
});

test("matchesInChunk count", () => {
  const fm = [
    { chunkIdx: 0, bodyIdx: 1 },
    { chunkIdx: 0, bodyIdx: 3 },
    { chunkIdx: 1, bodyIdx: 1 },
    { chunkIdx: 0, bodyIdx: 5 },
  ];
  const matchesInChunk = fm.filter((m) => m.chunkIdx === 0).length;
  assert.equal(matchesInChunk, 3);
});
