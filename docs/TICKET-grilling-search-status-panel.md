# Ticket: search status panel — design (grilling)

Type: grilling · Status: open · Blocked by: TICKET-task-search-flat-index (for exact field names)

## Question

What does the search status indicator look like, where does it live, and what fields does it show?

Context:
- User asked for "a panel somewhere indicating what search we are in, what file and how many instances of the result there are."
- The footer (`src/ui.mjs:1121–1144`) already owns mode display (`/buffer▌`, `\buffer▌`, etc.) and flash messages.
- The header bar (`src/ui.mjs:1149`) has its right side currently showing position/count info.
- There is no spare persistent line between header and the two panes.

Options:

**A — Enrich the existing footer line** when pattern is active:
```
\pattern  [match 4/12 · file 2/3 in path/to/file.ts]
```
Stays in one line, consistent with existing footer modes. Gets long for deep paths.

**B — Add a second-line sub-header** below the main header, visible only when a pattern is active:
```
▚▞ mrp · !42 · Some MR title                    5/38 · ackd 3 · seen 7/38
search: \pattern   match 4/12 total · 2/3 in components/Foo.tsx
```
Costs one terminal row but gives the info its own permanent home while searching.

**C — Integrate into the existing header's right side** as an additional counter when pattern is active:
```
▚▞ mrp · !42 · title …   \pattern 4/12 (2/3 in file) · ackd 3 · seen 7/38
```
No extra row; may get cramped.

Open sub-questions:
1. Should the panel show the **full file path** or just the basename? (Long paths eat space.)
2. Should it show **total instances across all files** alongside **instances in the current file**, or just one?
3. When pattern is cleared (`Esc`), the indicator disappears. Should it leave any trace (e.g., `last search: \pattern`)?
4. Should there be a keyboard shortcut to re-activate the last pattern without retyping it?

## Resolution

*(to be filled in)*
