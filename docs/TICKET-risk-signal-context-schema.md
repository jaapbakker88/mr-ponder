# Signal Context Schema

Type: **grilling + prototype**
Blocked by: *(nothing — frontier)*
Blocks: [Stage API Contract](TICKET-risk-stage-api-contract.md), [Git Signal Fetcher](TICKET-risk-git-signal-fetcher.md)

## Question

What fields does the context bag passed to every stage contain? This is the
read-only object the pipeline runner assembles *once* per chunk before invoking
any stage. Getting this right is load-bearing: it defines what built-in stages
can reference, what custom stages can rely on, and what the git signal fetcher
must produce.

Decisions to make:

**What signals are in context?**

Currently computable from existing code:
- `fanOut: number` — import count from rg (0 if not shared)
- `fanOutFailed: boolean` — rg couldn't assess this file
- `importers: string[]` — repo-relative paths of importing files
- `sensitivity: number` — summed rule weight
- `sensLabels: string[]` — matched rule labels
- `shared: boolean` — file is under a shared module path
- `isTest: boolean` — file matches test/spec pattern
- `metaOnly: boolean` — rename/delete with no line changes

New signals (require git, only when `repoDir` is present):
- `churn: number` — commit count touching this file in last N days/commits
- `lastTouchedDaysAgo: number` — days since most recent commit to this file
- `authorCount: number` — distinct authors who have touched this file
- `primaryAuthor: string | null` — author with the most commits to this file

**Nullability**: when `repoDir` is absent (no local checkout), git-derived fields
are unavailable. Should they be `null`, `undefined`, or missing from the object
entirely? Or should the runner always include them with a sentinel value (e.g. `-1`)?

**Chunk fields**: stages also need the raw chunk data (file path, line counts,
op type). Are these on `chunk` (passed separately) or merged into `ctx`?

**Immutability**: should the runner freeze the context object to prevent stages
from accidentally mutating shared state?

**What to decide here:**
1. Exact field names and types (TypeScript/JSDoc schema)
2. Sentinel strategy for unavailable git signals
3. Whether chunk data is in `ctx` or passed as a separate first argument
4. Freeze/seal policy
