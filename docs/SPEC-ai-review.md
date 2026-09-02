# Spec: AI-assisted mini review (per-chunk)

**Status:** DESIGN (no code yet) · **Priority:** P2 (opt-in, nice-to-have) · **Drafted:** 2026-08-26

A pattern-spotting aid, not a reviewer replacement: on demand, for the chunk
you're currently looking at, ask a small/cheap model "what stands out here?"
and show the answer next to your own notes. One request, one response — no
chat, no session, no crawling the rest of the MR.

Design constraints (non-negotiable):
- **Opt-in, on-demand only.** Triggered by a single keypress on the focused
  chunk. Never runs automatically, in bulk, or on startup.
- **Single request/response.** No multi-turn session, no follow-up questions,
  no tool access for the model.
- **Scope is bounded, not MR-sized.** The request is the focused chunk plus a
  small, capped set of *connections* (see below) — never "read the whole
  diff." Cost and latency stay flat regardless of MR size.
- **Cheap by default.** Claude Haiku 4.5 via Bedrock
  (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) — modern enough to spot real
  issues, cheap enough to press without thinking about it. Overridable via
  `MR_AI_MODEL` for an occasional Sonnet upgrade on a gnarly chunk.
- **Reuses existing AWS credentials.** Default credential chain, respects
  `AWS_PROFILE` (this machine already has a working `claude-code-profile` SSO
  profile in `us-east-1`). No new secrets, no new config file.
- **Clearly not a human note.** Output is visually distinct, stored separately
  from `notes{}`, and never auto-promotable to GitLab (`P`).

---

## Trigger & panel layout

Key **`a`** (unbound today — checked against every `lc === "…"` case in
`ui.mjs`'s `useInput`), on the currently focused chunk. Toggle it again (or
`Esc`) to close.

Docked at the bottom of the hunk pane, **same pattern as the importers panel**
(`i`, `ui.mjs:909-925`) — not the modal help screen. Reasoning: AI output is
prose (a few sentences/bullets), not a single line like a note/tag
(`ui.mjs:898-904`, `wrap: "truncate"`), so it needs the importers panel's
shape: a bordered `Box`, capped to a fraction of the pane height
(`Math.max(3, Math.floor(bodyH / 2))`) with a "+N more" tail if it runs long,
and **not modal** — sidebar/hunk navigation keeps working behind it, same as
importers. While loading, the panel shows a spinner line ("asking bedrock
(haiku)…") in place of the result text; no separate spinner overlay.

Unlike `editorPrompt` (`ui.mjs:48`, `spawnSync(..., { stdio: "inherit" })`),
this needs **no** alt-screen/raw-mode handling — it's a plain async network
call behind `useState`, not a foreground subprocess taking over the terminal.

## Scope: chunk + bounded connections

This is the scope-creep guard the feature exists to have: no matter how big
the MR is, the request size is bounded by a small constant, not by MR size,
and never grows by crawling.

Reuse the existing relatedness signals rather than inventing new ones —
`suggestLinks` (`suggest.mjs:93`) already ranks same-file / same-tag /
import-edge candidates for the `l` link-picker:

- **Always include** chunks the reviewer has **already linked** to this one
  (`linksFor(state, chunk.id)`, `store.mjs:160`) — those are deliberate human
  connections, so they're in regardless of count (in practice always small).
- **Additionally include** up to **`N = 2`** auto-suggested connections from
  `suggestLinks(chunk, chunks, state, importEdges, 2)` — top-scored only.
- **Hard cap:** primary chunk + **at most 4 connections total**, **one hop
  only** (never pull a connection's own connections).
- Each connection is passed as: file path, the reason it was suggested
  (`same file` / `import edge` / `#tag`), and its own hunk body — trimmed to
  ~40 lines if huge, the same "quick glance" scope as the primary chunk, never
  the full file.

## Prompt shape

- **System:** terse — spot concrete issues or inconsistencies (bugs, a
  mismatch with a connected chunk, a missed edge case), not style nits; cite
  line numbers; if nothing stands out, say so plainly rather than padding.
  No tool access, no repo access — it only ever sees what's handed to it
  (mirrors the `review` skill's own "AI proposes, grep disposes" caution:
  this is a proposal for the human to weigh, same trust level as a note).
- **User:** the primary chunk (file, hunk body, risk labels already computed —
  `sensLabels`, `shared`, `fanOut`, `unknown`, `isTest`) + the connections
  array (reason, file, hunk body).

## API call

New `src/ai.mjs`:

```js
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = process.env.MR_AI_MODEL || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export async function reviewChunk(chunk, { chunks, state, importEdges }) {
  // assemble bounded context (see above), one ConverseCommand, return:
  // { text, model, at }
}
```

Region from `AWS_REGION` / default `us-east-1`. New runtime dependency:
`@aws-sdk/client-bedrock-runtime` (plain npm package, no build step — same
deal as `ink`/`react`).

## State changes

New store field, same shape family as `notes{}` (`store.mjs`):

```
aiNotes: { [chunkId]: [{ text, model, at, connections: [chunkId, …] }] }
```

- `connections` records which chunk ids were actually included, so a stale
  AI note is legible later ("this was written against these 3 other chunks").
- Sidebar/hunk marker: a **distinct** glyph/color from `▸` (notes) — e.g. `✦`
  — so AI output can never be mistaken for the reviewer's own thinking at a
  glance.
- **Not eligible for `P` promote.** A human decides whether an AI observation
  becomes a real note/comment; it is never auto-posted.
- `--export` includes `aiNotes` only under `--all` or a future
  `--include-ai` flag — default export stays a signal of what the *reviewer*
  flagged, not what the model guessed.

## Failure modes

- Expired SSO token / no credentials → flash a friendly inline error ("run
  `aws sso login --profile claude-code-profile`"), don't crash Ink.
- Bedrock throttling/timeout → flash + leave no `aiNotes` entry (retryable,
  same posture as a failed `glab` post in `SPEC-promote-and-export.md`).
- Chunk is `unknown` / binary / `metaOnly` → skip, nothing useful to send.

## Sequencing

1. `ai.mjs` + one-shot call + docked panel (importers-style) showing a spinner
   then plain-text result, no connections yet — smallest slice, validates the
   Bedrock plumbing end to end.
2. Bounded connections via `suggestLinks` — the scope-creep guard.
3. State persistence (`aiNotes`) + distinct marker glyph.
4. Export inclusion (opt-in flag).

## Open questions (need a human call)

- Is `N = 2` auto-suggested connections the right number, or should the
  budget flex with chunk risk (e.g. 0 for a trivial chunk, more for a
  sensitive one)?
- Should a sensitive chunk (`sensLabels.length > 0`) ever get a bigger model
  automatically, or is model choice always the explicit env-var override,
  never automatic? (Lean: always explicit — keeps cost predictable and
  behavior boring.)
- Marker glyph/color for AI notes — something that reads as "machine,
  glance-worthy," not "your work."
