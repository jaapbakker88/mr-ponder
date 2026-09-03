# Design decisions

A running log of the choices behind `mrp` and why, so future changes don't
re-litigate settled questions (or knowingly revisit them).

## Notes are local-first, never auto-posted

**Decision:** notes/tags/links live in a local JSON file per MR; posting a note
to GitLab as a review comment is a separate, deliberate, later action.

**Why:** `mrp` is a *thinking* tool for connecting the dots across a big change.
Half-formed thoughts and "this relates to that" links are exactly what you don't
want leaking into a public MR thread. The GitLab VS Code extension already does
in-place public commenting; `mrp` fills the private-scratchpad gap.

## Two-pane layout (sidebar + hunk), not single-pane

**Decision:** a persistent left sidebar (files → chunks with markers) beside the
hunk pane, rather than a one-hunk-at-a-time view with a toggleable overlay.

**Why:** the original single-pane version forced you to hold the diff's geography
in working memory — you couldn't see where you were or what else existed. Linking
was especially bad: you'd press `l` and then navigate *blind* to a target. An
always-on map fixes both "overview at all times" and "jump between files", and
makes suggestion-based linking natural.

## Focus model via `Tab`, not separate scroll keys

**Decision:** `Tab` toggles focus between sidebar and hunk. In sidebar focus,
`j`/`k` move between chunks; in hunk focus, `j`/`k` scroll the diff body.

**Why:** matches the standard two-pane mental model (and what the user reached
for). Avoids inventing extra chord keys for scrolling, and keeps `j`/`k` meaning
"move within whatever I'm focused on."

## Risk-first chunk ordering

**Decision:** order chunks by a blast-radius score — shared-dir membership +
import fan-out (how many modules import the changed file) — with tests pushed to
the bottom.

**Why:** read the highest-consequence code while attention is freshest. Reuses
the fan-out machinery from `mrs`. A leaf feature file is skim-only; a change to a
hook imported by 95 modules is where a human should look first.

## Link suggestions: file + tag + import-edge

**Decision:** rank link candidates by three structural signals — same file,
shared tag, and import-edge (chunk A changes `@/x`; chunk B's file imports
`@/x`). Shared-symbol matching was considered and rejected as too noisy.

**Why:** these three are precise and low-noise. Raw shared-identifier matching
surfaced junk (`Group`, `Name`, `Type`) far more than useful domain symbols.

## Import extraction: local checkout, with diff fallback

**Decision:** to find a file's imports for edge detection, read the local
checkout first; if the file isn't on disk (the MR branch isn't checked out),
fall back to imports visible in the file's own diff.

**Why:** the local repo is usually on `develop`, so MR-branch files may not exist
locally — the local-only path found **0** edges on a real MR. The diff fallback
recovered real edges without requiring a checkout or N extra API calls. It
undercounts (imports above the changed hunks aren't in the diff window) but never
errors.

## Stable chunk ids keyed by head SHA

**Decision:** each chunk id is `file@oldStart:newStart`; the state file records
the MR head SHA and warns when it changes (force-push), listing orphaned ids.

**Why:** annotations must survive a re-fetch when a hunk didn't move, and must
*not* silently re-attach to shifted lines when the branch was rewritten.

## No build step (Ink via `React.createElement`)

**Decision:** write the UI with `h = React.createElement` instead of JSX.

**Why:** keeps the tool a set of plain `.mjs` files runnable under `node` with no
Babel/esbuild pipeline — matching the low-friction, single-file spirit of `mrs`.
The cost is verbosity in `ui.mjs`, accepted deliberately.

---

# Threat-model assessment (principal-engineer lens)

Reviewed 2026-08-26 through the lens of *the actual job `mrp` claims to serve*:
a principal engineer reviewing a stream of large, AI-generated MRs, whose scarce
resource is reviewer attention and whose liability is what slips through. This
section records **what has to be true for `mrp` to be the review tool of record**,
not just a personal reading aid. It governs future changes: a change that improves
code quality but doesn't move this table is not moving the tool toward its purpose.

**Standing verdict:** `mrp` is a good *drafting / thinking* tool and should be used
as such today. It is **not yet fit as the review-of-record** until the P0 items
below land. The risk was never code quality — it's the *model*.

## The core mismatch: blast radius ≠ defect risk

**Observation:** `risk.mjs` scores chunks by import fan-out + shared-dir membership.
That is a *blast-radius* signal (how many files could be affected), not a
*defect-likelihood* or *consequence* signal.

**Why it matters for AI MRs:** the changes that slip through review are rarely the
widely-imported hook (breakage there is loud and caught). They are auth/authz
checks, money/tax math, migrations, deletes, PII handling, and infra/flag/CI
files — frequently *leaf* files with low or zero fan-out. An AI will confidently
produce a plausible auth bypass in a leaf file; the current model sorts it *below*
a whitespace change to a shared util. The tool actively routes the most dangerous
AI failure modes away from fresh attention.

**Governing decision (P0):** fan-out is *one* signal, not the dominant one. A
pluggable, path-based **sensitivity overlay** (regex → weight, org-configurable)
must let paths like auth/payment/migrations/policy/infra sort read-first regardless
of fan-out. See the prototype in `risk.mjs` (`SENSITIVITY`, config load).

**Implementation note (2026-08-26):** the first cut exposed a calibration bug —
with `fan*10`, a hook imported 117× scored 1220 and *still* outranked an auth leaf
(500), i.e. the overlay didn't actually achieve its goal. Fixed by **log-dampening
and capping fan-out** (`log10(fan+1)*115`, capped 300): reach has diminishing
returns (importer #117 ≈ #40), consequence is categorical. Verified against the real
repo the order is now migration/sql → money → auth → high-fan-out hook → leaf → test.
Config lives at `~/.config/mrp/sensitivity.json` (`src/sensitivity.mjs`,
`DEFAULT_RULES`); absent config uses sensible defaults so it works out of the box.

## "Seen" is a self-report, not coverage

**Observation:** `space` toggles a boolean; the header shows `seen N/total`.

**Why it matters:** at org scale that number *will* be read as a compliance signal
("was this reviewed?") and it is unfalsifiable — mark-all-seen takes seconds, with
no evidence anything was read.

**Governing decision (P1):** distinguish *displayed* from *engaged*. Cheapest honest
version: a chunk becomes "seen" only once its full body has been scrolled into view
(the UI already tracks `scroll`/`bodyH`). The gate metric should be "unseen risky
chunks remaining," not raw count.

**Implementation note (2026-08-26):** shipped as a **dual signal**, not a replacement —
`space` stays a manual *ack* ("I'm done"), and a new one-way `engaged` flag is set
automatically when the hunk's full body reaches the bottom of the pane (`markEngaged`,
`state.engaged{}`). Rationale: the concern is that the *coverage metric* lies, not that
manual marking is wrong; removing ack would cost reviewer agency on trivial hunks. The
header now reports both (`ackd N · seen M/total`) plus a `⚠ K risky unseen` gate
(sensitive/shared/unknown chunks not yet engaged). The `u` (unseen) filter keys off
`engaged`, not ack — "what have I actually looked at" is the honest question.

## Local-first is the right on-ramp and the wrong endpoint

**Observation:** review conclusions live in one JSON file on one laptop; promotion
to a GitLab comment is documented as "not yet built."

**Why it matters:** findings die on the machine — no audit trail, no handoff, no
cross-reviewer signal, and no feedback loop into the sensitivity weights above
(reviewer-note density per path is exactly the signal that should tune them).

**Governing decision (P0):** keep local-first as the *default drafting* state, but
build (a) promote-a-note-to-a-GitLab-comment (`diff_refs` are already fetched) and
(b) `mrp <iid> --export` emitting structured findings. The link graph — the tool's
most novel asset — must become shareable.

## Single-revision model dead-ends the re-review loop

**Observation:** `reconcile` detects a head-SHA change (force-push) and warns that
annotations may be stale, then re-presents the *entire* diff, risk-sorted from
scratch.

**Why it matters:** AI MRs iterate fast (push → comment → force-push). Re-reviewing
the whole diff on every push is precisely the war of attrition the vision promised
to end.

**Governing decision (P1):** incremental review — diff-the-diffs between the
last-reviewed SHA and head, letting the reviewer review only the delta. Highest-value
feature the tool does not yet have.

**Implementation note (2026-08-26):** `reconcile` now persists `reviewedChunkIds` (the
chunk-id set at the reviewed revision) and returns `newIds` = ids present now but not
last time — the delta. Chunks are tagged `isNew`; the UI shows a green `[new]` badge and
a `d` filter (delta-only). The delta base **advances each pass** (diffs vs the previous
review, not the original), so iterative force-push review stays focused on each new
increment. Note: this is delta-by-chunk-identity (`file@oldStart:newStart`), not a true
diff-of-diffs — a chunk whose *content* changed but whose start lines held is not yet
flagged. Good enough for the common force-push case; true content-delta is a follow-up.

**Implementation note (2026-09-03):** The content-delta follow-up is now shipped.
`diff.mjs` computes a `contentHash` (FNV-1a 32-bit, CRLF-normalised) for every chunk
body. `reconcile` now accepts `{ id, contentHash }[]` and persists `reviewedChunks`
(`{ [id]: hash }`). Delta logic: id absent → new; id present + hash differs → new AND
orphaned (prior annotations point at different code). The stale-SHA notice now reports
rewritten vs added/removed counts. Migration: old state files carry `reviewedChunkIds`
only; first run after upgrade uses id-only comparison and writes `reviewedChunks`,
giving full hash detection from the second run onward.

## No triage layer above a single MR (the mrs seam)

**Observation:** `mrp` opens one MR by `iid` that the reviewer already chose. It is
blind to "which of today's 30 MRs deserves attention first."

**Governing decision (P2):** `mrp` stays single-MR by design, but the risk *model*
must be shared with `mrs` so triage and deep-read agree on "risky." This is the real
stakes of the `SHARED_RE` divergence noted under "Known gaps" — not cosmetic; two
tools disagreeing about risk.

## Fail-loud, not fail-quiet, on unknowns

**Observation:** `fanOut` errors → 0; `importSpec` unresolvable → null → risk 0.
Fan-out is also computed against local `develop`, not the MR branch, so newly-shared
surface is systematically under-scored.

**Governing decision (P2):** unknown/unresolvable risk should sort *up*, not down —
"I couldn't assess this" is a reason to look, not to skip. Prefer scoring against the
MR branch where feasible.

**Implementation note (2026-08-26):** first cut wired `unknown = shared && !spec`,
which is *unreachable* — every `SHARED_RE` match also resolves via `importSpec`
(caught by a test that documented the dead branch). Corrected: `fanOut` now returns
`{count, failed}`, distinguishing rg exit 1 (real 0 matches) from exit 2 / rg-missing
/ dir-absent (genuinely un-measurable). `unknown` fires on `failed`, applying a
+75 fail-loud nudge. Lesson: a "fail-loud" path is worthless if its trigger can't
fire — assert the trigger, not just the effect.

## Adoption gate (priority-ordered)

| P | Gap | Why it's the gate |
| - | --- | ----------------- |
| P0 | Path-sensitivity risk overlay | Core value prop is mis-aimed at the AI threat model — **DONE** (prototype + tests, verified on real repo) |
| P0 | Promote-to-comment + structured export | Findings must leave the laptop or the org can't rely on them — **DONE** (export json/md via `--export`; promote via `P` with A1 anchoring, `SPEC-promote-and-export.md`) |
| P1 | Incremental "review the delta since last SHA" | Without it, re-review at scale is attrition — **DONE** (chunk-identity delta; content-delta is follow-up) |
| P1 | Honest "engaged" vs "displayed" seen | `seen` is read as compliance; today it lies — **DONE** (dual ack/engaged signal + risky-unseen gate) |
| P2 | Score MR-branch imports; sort unknowns up | Fail-loud on the risky direction — unknowns DONE; MR-branch scoring open |
| P2 | Shared risk model with `mrs` | Triage and deep-read must agree on "risky" — **PARKED** (see "Known gaps", needs cross-repo decision) |

## Follow-the-thread navigation: `n`/`N`, `*`, `/` body search

**Decision (2026-08-31):** three features shipped together to address the core
friction of reviewing AI-generated MRs with no narrative: you land on a chunk cold
and need to understand why code is split the way it is.

**`n`/`N` — hop between pattern matches**

When `\` is active, `n` moves to the next matching chunk and `N` to the previous,
wrapping. Critically, both work regardless of whether sidebar or hunk pane has
focus — you can read a hunk and press `n` to jump to the next match without
switching focus first. When no pattern is active, `n` falls through to the note
editor (unchanged).

**`*` — set `\` from an identifier in the current chunk**

Press `*` on any chunk to see a ranked list of identifiers from that chunk that
appear in at least one other chunk in the diff. Two signals, in priority order:

1. The `@@` context line identifier (the enclosing function/class/type name) —
   one per chunk, highest confidence.
2. Exported declarations (`export const/function/class/type/interface`) in added
   lines only, skipping comment lines — requires `export` so only symbols actually
   reachable from other files are candidates.

Candidates shorter than 6 chars or on a small stoplist (`default`, `render`,
`children`, …) are filtered. Ranked by how many other chunks mention each one.
Pick `1`–`9` → sets `\` to that identifier; `n`/`N` then hop through all
occurrences. The two features compose: `*` → pick → `n`/`N` is the full
"follow the thread" loop.

**Why not auto-set on single candidate:** the first version silently set the
pattern when only one candidate existed. In practice this was confusing — the
reviewer couldn't see what was selected or why. Always showing the panel gives
visibility and feels intentional.

**`/` searches diff body as well as metadata**

Previously `/` searched only file path, `@@` context, notes, and tags; `\`
searched only the diff body. The split was designed as complementary but in
practice was just confusing — typing `/useFeatureFlag` returned nothing because
the reviewer didn't know to use `\`.

`/` now searches all of the above plus the diff body (case-insensitive substring).
`\` remains distinct: regex support, and in-hunk highlighting of matches. The
distinction is now *find* vs *find + highlight*.
