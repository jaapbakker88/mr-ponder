# Git Signal Fetcher Design

Type: **grilling + prototype**
Blocked by: [Signal Context Schema](TICKET-risk-signal-context-schema.md)
Blocks: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md)
**Status: RESOLVED**

## Resolution

Days-based churn window (default 90). Author identity by email. `--follow` enabled.

### Single-pass fetch per file

One `git log` invocation per file derives all three signals:

```sh
git log --follow --format="%ae%x00%at" --since=<90-days-ago> -- <path>
# Each line: author-email NUL unix-timestamp
# Derive:
#   churn              = line count (number of commits in window)
#   lastTouchedDaysAgo = (now - max(timestamp)) / 86400, rounded down
#   authorCount        = distinct email count
#   primaryAuthor      = most-frequent email (null if no commits)
```

`lastTouchedDaysAgo` uses the full history (no `--since`), so a stale file is
detected even when churn in the window is 0. Two separate invocations:

```sh
# 1. Windowed (for churn + authorship)
git log --follow --format="%ae%x00%at" --since=<windowDate> -- <path>

# 2. Single most-recent commit (for lastTouchedDaysAgo)
git log --follow --format="%at" -1 -- <path>
```

Both are run in parallel per file.

### Caching

Results cached in a `Map<filePath, Promise<GitSignals>>` keyed on the
repo-relative path. Multiple chunks touching the same file share one fetch.
Cache lives for the lifetime of one `mrp` run (no persistence).

### Absent `repoDir`

When `repoDir` is `null` the fetcher is skipped entirely. All four git fields
(`churn`, `lastTouchedDaysAgo`, `authorCount`, `primaryAuthor`) are set to
`null` in ctx. Stages use `?? 0` / `?? null` to handle gracefully.

### Parallelism

All files fetched in parallel (same pattern as the fan-out rg fetcher).
`git log` is read-only and stateless; no risk of contention.

### Config surface (consumed by the `churn` stage, not the fetcher itself)

```jsonc
{ "name": "churn", "window": 90 }  // window in days; default 90
```

The fetcher always uses the window declared in the active `churn` stage config,
falling back to 90 if absent or if no `churn` stage is in the pipeline.

---

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
