# mr-ponder (`mrp`)

`git add -p`, but for **reviewing** an existing GitLab merge request instead of
staging changes. Step through a MR's diff hunk-by-hunk — risk-first — and attach
**private** notes, tags, and chunk-to-chunk links so you can connect the dots
across a large change without holding the whole thing in your head.

It is a separate tool from `mrs` (the MR dashboard); they share nothing but the
authenticated `glab` CLI.

## Why

AI-assisted development produces large, high-blast-radius MRs faster than a human
can read them top-to-bottom. `mrp` reframes the review as:

- **risk-first** — chunks touching shared modules (weighted by import fan-out)
  float to the top; tests sink to the bottom, so you read the scary code while
  fresh instead of alphabetically.
- **a thinking tool** — notes/tags/links are local and private (never posted),
  so you can jot half-formed thoughts and link related chunks while you build a
  mental model. Promoting a note to a real GitLab comment is a deliberate,
  later step (not yet built).
- **spatially aware** — a persistent sidebar shows the whole change (files →
  chunks with seen/note/link/tag markers) so you always know where you are.

## Usage

```
mrp <iid>                     review MR !<iid>
mrp <iid> --project a/b/c     override project
mrp <iid> --refetch           re-pull the diff (after a force-push)
```

Environment:

- `MR_PROJECT`  — default project path.
- `MR_REPO_DIR` — local checkout used to compute import fan-out (blast radius).
- `EDITOR`      — editor used for notes (default `vi`).

## Keys

| Key | Action |
| --- | --- |
| `Tab` | switch focus: **sidebar** (move between chunks) ↔ **hunk** (scroll the diff) |
| `j`/`k` `↓`/`↑` | sidebar focus: prev/next chunk · hunk focus: scroll a line |
| `PgUp`/`PgDn` (or `Ctrl+u`/`Ctrl+d`) | scroll the hunk a page |
| `[` / `]` | jump to prev / next file |
| `g` / `G` | top / bottom (of the chunk list, or of the hunk when focused) |
| `space` | toggle "seen" |
| `n` | add a note (opens `$EDITOR`) |
| `t` | add a tag |
| `l` | link this chunk → pick a suggestion (`1`–`9`) or `f` to free-pick |
| `/` `u` `s` | filter / unseen-only / shared-only |
| `?` `q` | help / quit |

State is saved on every change.

## Architecture

Plain Node ESM + [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).
Written with `React.createElement` (aliased `h`) rather than JSX so it runs under
`node` with **no build/transpile step**.

```
mrp.mjs                 entry: parse args → fetch → score → reconcile → render
src/gitlab.mjs          thin async wrapper over the `glab` CLI (api, MR detail, changes)
src/diff.mjs            parse unified diffs into individual @@ hunks ("chunks")
src/risk.mjs            score/order chunks by blast radius (shared dir + import fan-out)
src/suggest.mjs         rank link candidates (same file / same tag / import edge)
src/store.mjs           per-MR local state (notes/tags/links/seen), keyed by head SHA
src/ui.mjs              the two-pane Ink TUI (sidebar map + hunk pane)
```

Data flow per run:

1. `fetchMrDetail` + `fetchMrChanges` (`glab api`).
2. `parseChanges` → flat list of chunks (one per `@@` hunk), each with a **stable
   id** = `file@oldStart:newStart` so annotations re-attach after a re-fetch.
3. `scoreChunks` + `riskOrder` → sorted risk-first.
4. `buildImportEdges` → producer/consumer map for link suggestions.
5. `loadState` + `reconcile` → merge persisted annotations; detect a changed head
   SHA (force-push) and flag orphaned chunk ids.
6. `render(<App>)`.

### State storage

One JSON file per MR:

```
~/.local/share/mrp/<project-slug>/<iid>.json
{ project, iid, headSha, fetchedAt, seen{}, notes{}, tags{}, links[] }
```

Keyed by `headSha` so a force-push is *detected* (SHA mismatch → warn), never
silently mis-attaching notes to shifted lines.

## Design decisions

See `docs/DECISIONS.md` for the rationale behind the local-first notes, the
two-pane layout, risk ordering, and the import-edge suggestion signal.

## Known gaps / next

- Keyboard behavior is verified structurally (render + logic) but the *feel* of
  the keys needs a real TTY — Ink can't be driven headlessly.
- `mrp`'s `SHARED_RE` is stricter than `mrs`'s (top-level `app/src/hooks/` only,
  not feature-local). `mrp`'s is the more correct blast-radius signal; the two
  tools should be reconciled.
- Not yet built: the web "map" view (visualize the link graph), and "promote a
  note to a GitLab comment" (the API supports it — `diff_refs` are available).
