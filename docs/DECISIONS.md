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
