# Spec: pattern search over hunk bodies (`\`)

**Status:** DONE (steps 1-3 shipped; step 4 sidebar glyph deferred, still open) · **Priority:** P2 (opt-in power tool) · **Drafted:** 2026-08-27 · **Shipped:** 2026-08-31

Reviewing an AI-assisted MR often means asking a code-shaped question of the
whole change at once: *where does this add a `useMemo`? where's a new
`console.log`? which chunks introduce an `as any` cast?* The existing `/` text
filter can't answer these — it matches the file path, context line, notes, and
tags (`ui.mjs:206-217`), never the diff body. This spec adds a **second,
regex-over-hunk-body filter** on its own key so you can slice the change by what
the code *is*, not just where it lives, and see the matches lit up in the pane.

`/` (find where you named it) and pattern search (find where the code does it)
are complementary; this keeps both.

## Problem

The `visible` memo (`ui.mjs:199-223`) narrows chunks through a stack of
predicates — `unseenOnly`, `sharedOnly`, `deltaOnly`, `testFilter`, then the
`/` text `filter`. That text filter (`ui.mjs:206-217`) only ever reads
`c.file`, `c.context`, the chunk's notes, and its tags:

```js
if (filter) {
  const q = filter.toLowerCase();
  list = list.filter((c) => {
    const notes = (state.notes[c.id] || []).map((n) => n.text).join(" ");
    const tags = (state.tags[c.id] || []).map(tagName).join(" ");
    return (
      c.file.toLowerCase().includes(q) ||
      (c.context || "").toLowerCase().includes(q) ||
      notes.toLowerCase().includes(q) ||
      tags.toLowerCase().includes(q)
    );
  });
}
```

The one thing it never touches is `c.body` — the array of raw diff lines
(`diff.mjs`: each chunk carries `body: [headerLine, ...diffLines]`, where added
lines start `+`, removed `-`, context ` `). So "which chunks add a `useMemo`?"
is unanswerable today short of eyeballing every hunk. That's exactly the
line-by-line slog `mrp` exists to avoid.

## Design

A **separate** filter, on its own key, layered into the same `visible` memo as
one more predicate. It does not replace or fold into `/` — the two are
orthogonal (`/` = metadata/notes, `\` = code body) and each can be active
independently.

### Match semantics

- **Regex**, compiled case-insensitive (`new RegExp(src, "i")`). If the source
  is not a valid regex, **fall back to a literal substring** match of the raw
  text rather than erroring — the reviewer typing `foo(` shouldn't get a "bad
  regex" wall, they should get literal `foo(` matches. (Flash a subtle hint
  that it fell back to literal, so an *intended* regex typo isn't silently
  mis-scoped.)
- **Matched against added (`+`) and context (` `) lines only** — never removed
  (`-`) lines. Pattern search is about the code the MR *results in*, not what it
  deleted; matching deletions would surface chunks that no longer contain the
  pattern, which is the opposite of the question being asked. The `@@` header
  line (always `body[0]`) is also excluded — its enclosing-fn context is already
  covered by the `/` filter's `c.context`.
- A chunk **matches** if any eligible body line matches. Filtering is at chunk
  granularity (same as every other predicate in `visible`); per-line
  highlighting (below) is what shows *where* within a matched chunk.

Shared helper so filter and highlight can't drift:

```js
// Lines eligible for pattern matching: added + context, never the @@ header
// or removed lines. Returns the raw line strings.
function patternEligibleLines(chunk) {
  return chunk.body.slice(1).filter((l) => !l.startsWith("-"));
}

// Compile a user pattern to a tester. Regex when valid (case-insensitive),
// literal-substring fallback otherwise. Returns { test(line), literal:bool }.
function compilePattern(src) {
  try {
    const re = new RegExp(src, "i");
    return { test: (l) => re.test(l), re, literal: false };
  } catch {
    const q = src.toLowerCase();
    return { test: (l) => l.toLowerCase().includes(q), literal: true };
  }
}
```

### State & the `visible` memo

New state alongside `filter` (`ui.mjs:134`):

```js
const [pattern, setPattern] = useState(""); // regex/substring over hunk bodies
```

Extend the `visible` memo (add a branch after the `/` `filter` block,
`ui.mjs:217`) and its dep array:

```js
if (pattern) {
  const p = compilePattern(pattern);
  list = list.filter((c) => patternEligibleLines(c).some(p.test));
}
...
}, [chunks, state, unseenOnly, sharedOnly, deltaOnly, testFilter, filter, pattern, orderMode]);
```

Layering it here means it composes with everything for free — pattern +
`unseen-only`, pattern + `hide tests`, pattern + `/` metadata filter all stack,
and it reorders correctly because `orderChunks` runs last on whatever survives.
The existing `safeIdx` clamp (`ui.mjs:225`, `232-234`) already handles the list
shrinking under the cursor, and setting `idx`/`scroll` to 0 on apply (below)
mirrors how the `/` filter and the `u`/`s`/`d`/`e` toggles all reset position.

### Trigger & input mode

Key **`\`** (backslash — unbound today; visually echoes `/` as "the *other*
slash"), entering a text-entry mode exactly like the `/` search mode. The
input-mode machinery already exists (`ui.mjs:445-469`): `mode === "tag" ||
mode === "search"` share one buffer-editing block. Add `"pattern"` to that set
so it reuses the same backspace/append/return/escape handling verbatim:

- `\` in normal mode: `setMode("pattern"); setBuffer("");` (mirror the `/`
  handler at `ui.mjs:590`).
- `Enter` while `mode === "pattern"`: `setPattern(buffer); setIdx(0);
  setScroll(0);` (mirror `ui.mjs:454`).
- `Esc` while `mode === "pattern"`: clear it — `setPattern(""); setIdx(0);
  setScroll(0);` (mirror `ui.mjs:463`).

Extend the text-entry guard:

```js
if (mode === "tag" || mode === "search" || mode === "pattern") {
  ...
  if (mode === "pattern") { setPattern(buffer); setIdx(0); setScroll(0); }  // in the return branch
  ...
  if (mode === "pattern") { setPattern(""); setIdx(0); setScroll(0); }      // in the escape branch
```

Footer prompt line (mirror `ui.mjs:945`, distinct color so it's not confused
with `/`):

```js
: mode === "pattern" ? h(Text, { color: "yellow" }, `\\${buffer}▌  (regex over +/context lines · Enter=apply, Esc=clear)`)
```

### In-hunk highlighting

When a pattern is active, the matched substrings inside a matched chunk's body
lines are lit up in the hunk pane, so once the filter narrows you to the right
chunks the eye lands on the exact spot without re-scanning the hunk.

The hunk pane renders each visible body line at `ui.mjs:886-895`:

```js
return h(Text, { key: i, wrap: "truncate", inverse: isCursor || inSel },
  h(Text, { color: numColor, dimColor: !numColor }, (r.num ? ... : "").padStart(gw) + " "),
  h(Text, { color: diffLineColor(r.line) }, r.line || " "));
```

Today the line text is one `Text` node colored by `diffLineColor` (green add /
red remove / dim context). To highlight, split that single node into
alternating **plain / matched** segments when a pattern is active and the line
is eligible (added or context):

- Split `r.line` on the compiled regex (`String.prototype.split` with a
  **capturing** group, or iterate `matchAll`) into `[before, hit, after, hit,
  …]`.
- Non-matched segments keep `color: diffLineColor(r.line)`.
- Matched segments render **`bold` + `underline`** on top of the same
  `diffLineColor` — deliberately *not* `inverse`/`backgroundColor`, because the
  cursor/selection row already owns `inverse` (`isCursor || inSel`), and the
  render code has a hard-won warning (`ui.mjs:668-672`) that nesting per-cell
  `color` inside an `inverse` `Text` makes Ink 5 leak escape state onto later
  rows. Bold+underline composes cleanly whether or not the row is also the
  inverse cursor row.
- Removed lines and the `@@` header: never highlighted (not eligible), rendered
  exactly as today.

Helper, colocated with the render:

```js
// Break a line into [{text, hit}] segments against the active pattern's regex.
// Literal-fallback patterns highlight nothing extra beyond having filtered the
// chunk in (no regex to segment on) — acceptable: the filter already narrowed
// the list; highlighting is the bonus, not the contract.
function highlightSegments(line, compiled) {
  if (!compiled?.re) return [{ text: line, hit: false }];
  const out = [];
  let last = 0;
  for (const m of line.matchAll(new RegExp(compiled.re.source, "gi"))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), hit: false });
  return out;
}
```

Guard rails already in place that this must respect:
- `wrap: "truncate"` on the row — segments concatenate to the same string, so
  truncation still works; a match past the truncation column just isn't shown
  (consistent with any long line today).
- The empty-line placeholder (`r.line || " "`) — an empty context line has no
  matches, one plain segment, unchanged.

### Sidebar marker (optional, sequenced last)

A chunk that matches the active pattern could get a transient sidebar glyph so
you can see the distribution of matches across files at a glance, but the marker
row (`chunkMarkEls`, `ui.mjs:676-686`) is already four columns
(seen/note/link/tag) and is about **persisted annotations**, not transient
filter state. Adding a fifth, ephemeral column risks muddying that meaning.
Deferred — the filtered `visible` list *is* the "which chunks match" view; a
per-row glyph is a nice-to-have, not core. Revisit only if the flat list proves
insufficient in practice.

## Interaction with the order/anchor work

`SPEC-order-toggle-anchor.md` makes `o` (order toggle) anchor on the focused
chunk instead of resetting to the top. Applying/clearing a pattern **does**
reset `idx`/`scroll` to 0 — and that's correct here, not a regression: unlike a
pure reorder, a filter changes *which chunks are in `visible` at all* (the
focused chunk may not survive the filter), so "stay on the same chunk" has no
guaranteed meaning. This matches the reasoning in that spec's "Out of scope"
note about the `u`/`s`/`d`/`e` filter toggles. No anchoring for `\`.

## Failure modes / edge cases

- **Invalid regex:** literal-substring fallback (above), with a one-time flash
  ("`\pattern` isn't valid regex — matching literally"). Never crashes the memo.
- **Pattern matches nothing:** `visible` goes empty → the existing empty-state
  line renders ("No chunks match the current filter.", `ui.mjs:817`). Consider a
  pattern-specific variant so the reviewer knows *which* filter emptied the list
  when both `/` and `\` are set; low priority.
- **Catastrophic-backtracking regex** on a huge body: the memo runs on every
  keystroke of *other* keys via its deps. Compile the pattern **once** per memo
  run (done — `compilePattern` is called once, not per line), and match against
  `patternEligibleLines` (already excludes removed/header noise). If pathological
  patterns prove a real hang risk, cap matched line length or wrap `test` in a
  length guard — deferred until observed.
- **`metaOnly` / binary / no-`@@` synthetic chunks** (`diff.mjs`): their `body`
  is a one-line human summary, not code. `patternEligibleLines` still runs
  (slice(1) may be empty → no match), so they simply never match a code pattern.
  Correct — there's no code there to pattern-search.
- **Pattern active + `/` filter active:** both predicates AND together in the
  memo (metadata *and* body must match). Intended; the footer shows whichever
  input mode is being edited, and a future footer badge could show both are
  armed.

## Sequencing

1. **Filter only.** `pattern` state, `\` mode reusing the `search` input block,
   `compilePattern` + `patternEligibleLines`, the extra `visible` predicate,
   footer prompt. No highlighting yet — smallest slice that answers "which
   chunks introduce X?" and is independently useful.
2. **In-hunk highlighting.** `highlightSegments` + splitting the body-line
   `Text` node into plain/matched segments (bold+underline). This is the part
   that touches the delicate inverse-row render path — do it second, on top of a
   working filter, and eyeball it against a cursor row + a selection row to
   confirm no escape-state bleed (`ui.mjs:668-672`).
3. **Literal-fallback UX polish** (the "matched literally" flash) + empty-state
   wording that names the pattern filter.
4. *(Deferred)* sidebar match glyph, only if the flat list proves insufficient.

## Acceptance

1. Open an MR that adds a `useMemo` somewhere. Press `\`, type `useMemo`, Enter:
   `visible` narrows to only the chunks whose added/context lines contain
   `useMemo`; the header chunk count drops accordingly; `Esc` (while re-entering
   `\`) or clearing restores the full list.
2. Type a regex (`use(Memo|Callback)`), Enter: chunks adding *either* hook match.
3. Type an invalid regex (`foo(`), Enter: no crash — chunks containing the
   literal text `foo(` match, and a flash notes the literal fallback.
4. With a pattern active, the matched substrings inside a matched chunk's hunk
   body are bold+underlined in the hunk pane, on both context and added lines,
   with no color bleed onto the cursor row or rows below it.
5. `\` composes with `/`, `u`, `s`, `d`, `e` and with `o` order toggling: every
   combination narrows/reorders coherently and the cursor never teleports past
   the end of the filtered list.

## Out of scope

- Match navigation (jump cursor `n`/`N` between matches within/across chunks) —
  a plausible follow-up once filter + highlight land, but not this spec.
- Persisting the pattern to disk — transient session state only, same as `/`.
- Saved/named pattern presets (a "useMemo / console.log / as any" menu) — could
  layer on top later; the raw `\` regex box is the primitive that would power it.
- Matching against removed lines or the full file (only the diff window + only
  added/context, deliberately — see Match semantics).
