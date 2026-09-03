# Spec: promote-to-comment & structured export

**Status:** DONE (see note) · **Priority:** P0 (adoption gate) · **Drafted:** 2026-08-26 · **Shipped:** 2026-09-02
**Note:** all four sequencing steps shipped — B-json, A1, A2 (line-precise via
`note.range`), B-md. Verified against the code 2026-09-02: `buildExport`/
`toMarkdown` (`src/export.mjs`, tested in `tests/export.test.mjs`), `P` →
`promoteCurrentNote` (`src/ui.mjs`) with confirm flow and
`markNotePromoted`-only-on-success, `postDiffNote`/`buildPosition` for both
`gitlab.mjs` and `github.mjs`. **One spec item intentionally dropped:** the
in-TUI export key (`e`) — `e` was later assigned to the test-filter cycle, and
CLI `--export` covers the exit. Also shipped beyond spec: stale-promoted
awareness via `promoted.headSha`, `engaged` in the summary, `range` on notes/
tags/links in both formats.

Companion to the P0 items in `DECISIONS.md` → *"Local-first is the right on-ramp
and the wrong endpoint."* Today a review's conclusions live in one JSON file on one
laptop. This spec defines the two exits that make `mrp` usable as the review tool of
record: **(A) promote a private note to a real GitLab discussion**, and **(B) export
the whole review as structured data** for audit, handoff, and feedback into the risk
model.

Design constraints (inherited, non-negotiable):
- Local-first stays the **default**. Nothing posts automatically. Promotion is an
  explicit, per-note action; export is an explicit command.
- No new runtime deps. `glab` CLI + Node stdlib only.
- Must survive force-push: a promoted comment anchors to a revision; a re-review
  must not silently mis-attach.

---

## A. Promote a note to a GitLab comment

### Trigger
In the hunk pane, on a chunk that has ≥1 note: key **`P`** (capital — destructive-ish,
leaves the laptop). Opens a confirm affordance listing the note text + exact anchor
that will be posted; `y` posts, `Esc` cancels. Never bulk-posts.

### Anchoring
GitLab diff-note position requires:
```
position[position_type]=text
position[base_sha]      = diff_refs.base_sha
position[head_sha]      = diff_refs.head_sha
position[start_sha]     = diff_refs.start_sha
position[new_path]      = chunk.file
position[old_path]      = chunk.file            (or old_path on rename/delete)
position[new_line]      = <line within the hunk>   (added/context)
position[old_line]      = <line within the hunk>   (removed/context)
```
`diff_refs` is already fetched in `fetchMrDetail` (see `gitlab.mjs:41`). **Gap to close:**
a note today attaches to a *chunk* (`file@oldStart:newStart`), not a *line*. Promotion
needs a line. Two options:
- **A1 (min):** post at the hunk's first changed line (`chunk.newStart`). Coarse but
  always valid. Ship this first.
- **A2 (better):** when adding a note, capture the currently-focused body line's
  new/old line number (the UI already computes these in `withLineNumbers`). Store it
  on the note: `{ text, at, line?: {new?, old?} }`. Backward-compatible (optional field).

### API call
```
glab api --method POST \
  projects/:id/merge_requests/:iid/discussions \
  -f body="<note text>" \
  -f position[position_type]=text \
  -f position[base_sha]=... (etc.)
```
Wrap in `gitlab.mjs` as `postDiffNote(project, iid, position, body)`.

### State changes
Record promotion on the note so it's not double-posted and is visible in the UI:
```
notes[chunkId][i] = { text, at, line?, promoted?: { at, discussionId, headSha } }
```
- Sidebar/hunk marker: a note shows `▸` (local) vs `▲` (promoted).
- If `promoted.headSha !== current headSha`, show it as **stale-promoted** — the
  comment exists but was posted against an older revision (informational; GitLab
  keeps the original anchor).

### Failure modes
- `glab` post fails → flash the error, leave the note un-promoted (retryable). Never
  mark promoted on a failed POST.
- Chunk is `unknown`/synthetic (binary, no real line) → refuse promotion with a
  message; there's no valid text position.

---

## B. Structured export

### Trigger
CLI, non-interactive: `mrp <iid> --export [--format json|md] [--out PATH]`.
Default `json` to stdout. Runs the same fetch+score pipeline, loads state, emits, exits
(no TUI). Also available in-TUI via a key (**`e`**) writing to a temp file + flashing
the path.

### JSON schema (v1)
```jsonc
{
  "schema": "mrp.export/1",
  "project": "group/proj",
  "iid": 123,
  "headSha": "abc…",
  "exportedAt": "2026-08-26T…Z",
  "summary": {
    "chunks": 40, "seen": 31,
    "annotated": 12, "notes": 9, "tags": 5, "links": 4,
    "sensitiveChunks": 3, "unknownChunks": 1
  },
  "findings": [
    {
      "chunk": "app/src/services/payment/charge.ts@88:90",
      "file": "app/src/services/payment/charge.ts",
      "risk": 501, "sensitivity": ["money"], "fanOut": 0,
      "shared": true, "unknown": false, "seen": true,
      "notes": [{ "text": "rounding uses float, not minor units", "at": "…", "promoted": true }],
      "tags": ["billing"],
      "links": [{ "to": "app/src/services/tax/calc.ts@12:12", "label": "same rounding bug" }]
    }
  ]
}
```
- `findings` is **only annotated chunks** by default (`--all` includes every chunk with
  its risk score — useful for triage analytics).
- Links are emitted once, from the `from` side, to avoid double-counting.

### Markdown format
Human-readable review summary suitable for pasting into an MR description or a ticket:
risk-sorted findings, sensitivity badges, notes as bullets, a link graph section. This
is the "handoff" artifact.

### Why this shape
- **Audit trail:** answers "was this reviewed, and what was flagged?" with evidence
  (seen + notes + risk), not a bare boolean.
- **Feedback loop:** `sensitivity` + `notes` per path is exactly the signal to tune
  `sensitivity.json` weights over time (paths that attract many notes → raise weight).
- **Cross-reviewer:** JSON is diffable/aggregatable across reviewers and MRs.

---

## Sequencing
1. **B-json first** — pure additive, zero risk, immediately unlocks audit/handoff.
   No API writes, no anchoring subtlety.
2. **A1** (coarse hunk-line promotion) — the first write path; smallest anchoring risk.
3. **A2** (line-precise notes) — improves A1; backward-compatible state change.
4. **B-md** — presentation layer on top of the same data.

## Open questions (need a human call)
- **Promotion identity:** post as the reviewer's `glab` user — confirm that's desired
  vs. a bot account for auditability.
- **Resolve/So-what on re-review:** if a promoted note's chunk is orphaned after
  force-push, do we surface "your posted comment may be outdated"? (Lean yes, P1.)
- **Export destination:** stdout-only vs. a conventional `~/.local/share/mrp/exports/`
  drop. (Lean stdout + optional `--out`; let the caller decide.)
