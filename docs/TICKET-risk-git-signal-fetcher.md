# Git Signal Fetcher Design

Type: **grilling + prototype**
Blocked by: [Signal Context Schema](TICKET-risk-signal-context-schema.md)
Blocks: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md)

## Question

How does the pipeline runner fetch churn, recency, and authorship for each chunk's
file? These all derive from `git log`; the design question is how to batch and
cache the fetches efficiently for a MR that may touch dozens of files.

**Current art**: fan-out uses `rg` per-file with a `Map` cache keyed on import
spec. The git fetcher should follow the same pattern but can go further — all
three signals share a single `git log` invocation per file.

**Proposed single-pass fetch per file:**

```sh
git log --follow --format="%ae%x00%at" -- <path>
# Each line: author-email NUL unix-timestamp
# From this one pass, derive:
#   churn        = line count (commit count)
#   lastTouched  = max(timestamp) → days ago
#   authorCount  = distinct email count
#   primaryAuthor = most-frequent email
```

**Questions to resolve:**
1. **Window for churn**: count all commits ever, or only the last N days/commits?
   Needs to be configurable (see Config Schema). What's the right default?
2. **Author identity**: email vs display name? Email is more stable (no
   formatting drift), display name is more readable in the UI.
3. **`--follow` cost**: follows renames across history. More correct but slower
   on deep histories. Worth it, or use a faster no-follow fetch?
4. **Absent `repoDir`**: when `repoDir` is null/absent, all three signals are
   unavailable. Does the runner skip the fetch entirely (stages get null/sentinel)
   or does it attempt and fail gracefully?
5. **Cache granularity**: cache per file path (within one mrp run)? What happens
   if the same file appears in multiple chunks (common for large files)?
6. **Parallelism**: fetch all files in parallel (like fan-out does), or
   sequentially to avoid hammering `git`?
