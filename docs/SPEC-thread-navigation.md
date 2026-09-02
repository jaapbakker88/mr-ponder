# Spec: thread navigation (`n`/`N`, `*`, `/` body search)

**Status:** DONE · **Priority:** P1 (daily review friction) · **Drafted & shipped:** 2026-08-31

The core friction of reviewing large AI-generated MRs: you land on a chunk cold
and need to understand why code is split the way it is — what defines `useFeatureFlag`
here, and where it's consumed. GitLab's Ctrl+F only works within the page; `mrp`
previously had no way to chase a symbol across the whole diff without knowing to use `\`
and already knowing what to type.

Three features shipped together to close this gap. They compose into a single
"follow the thread" loop:

```
land on chunk → * (pick identifier) → n/N (hop between matches)
                ↑
                / also works: type the name, same result
```

---

## `n`/`N` — hop between pattern matches

### Problem

`\` filters the sidebar to matching chunks and highlights them in the hunk pane.
But to move between matches you had to Tab to the sidebar and press j/k — interrupting
reading the hunk.

### Design

When `\` is active, `n` moves to the next matching chunk (wrapping) and `N` to the
previous, regardless of which pane has focus. The move resets hunk scroll to the top.

`n` without an active pattern falls through to the note editor (unchanged behavior).
`N` without a pattern is a no-op.

Edge cases:
- Single match: flashes "only one match"
- No matches: flashes "no matches for `\…`" (only possible if filters change while
  the pattern is active)

### Implementation

`src/ui.mjs` — `lc === "n"` handler, lines ~700. Pattern check gates the branch;
direction determined by `input === "N"`.

---

## `*` — pick a shared identifier from this chunk

### Problem

`\` requires knowing what to type. On a cold chunk in an AI MR with no narrative,
you don't know the relevant identifier. `*` extracts candidates from the chunk itself
and cross-references them against the rest of the diff.

### Design

Press `*` in any mode → compute candidates from the current chunk → show numbered
pick list → pick `1`–`9` → sets `\` pattern → `n`/`N` to follow.

**Candidate sources (in priority order):**

1. **`@@` context line** (`chunk.context`) — the enclosing function/class/type name.
   Parsed via the declaration regex; one per chunk; highest confidence.
2. **Exported declarations in added `+` lines** — lines matching
   `export (const|let|var|function|class|type|interface|enum) Name`, skipping
   comment lines (`//`, `*`, `/*`, `#`). `export` is required: non-exported symbols
   can't be referenced cross-file, so they produce noise not signal.

**Filtering:**
- Minimum 6 chars (removes `id`, `key`, `ref`, `user`, etc.)
- Stoplist: `default`, `render`, `children`, `handler`, `callback`, `undefined`,
  `toString`, `prototype`, `constructor`
- Cross-chunk count ≥ 1 required: if no other chunk in the diff mentions the
  identifier, there's no thread to follow

**Ranking:** descending cross-chunk occurrence count; alphabetical tiebreak.

**Panel always shown** — even for a single candidate. The first iteration auto-set
the pattern on a single hit; this was confusing (the reviewer couldn't see what
was selected). Always showing the panel makes the action visible and intentional.

### Known limitations

- Non-exported identifiers used cross-chunk within the same file are missed by
  the `+`-line scanner; only the `@@` context covers intra-file cases.
- Heuristic: the regex can't distinguish a locally-named utility function from a
  public API. The export requirement is a strong but imperfect proxy.
- A future "passive connection hints" feature (show related chunks on the hunk
  header without a keypress) would make this flow even lower-friction.

### Implementation

`src/ui.mjs` — `extractIdCandidates()`, `DECL_RE`, `EXPORT_DECL_RE`, `ID_STOP`
constants; `identCandidates` state; `mode === "ident"` handler and render block;
`input === "*"` key handler.

---

## `/` body search

### Problem

`/` searched metadata (file path, context, notes, tags); `\` searched the diff body.
The split was designed as complementary ("find where you named it" vs "find where
the code does it") but in practice was opaque — typing `/useFeatureFlag` returned
nothing, and the reviewer didn't know why.

### Design

`/` now searches all of: file path, `@@` context, notes, tags, **and diff body**
(case-insensitive substring, same as the other metadata fields).

`\` remains distinct: regex support (with literal fallback), **in-hunk highlighting**
of matches, `n`/`N` navigation. The distinction is now *find* vs *find + highlight*.

Effectively: use `/` when you want to narrow the sidebar; use `\` when you want to
read the matches highlighted in context.

### Implementation

`src/ui.mjs` — `visible` memo's `filter` predicate, adds
`patternEligibleLines(c).some((l) => l.toLowerCase().includes(q))` as a final OR
clause. One line change.
