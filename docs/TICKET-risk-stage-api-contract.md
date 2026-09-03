# Stage API Contract

Type: **grilling + prototype**
Blocked by: [Signal Context Schema](TICKET-risk-signal-context-schema.md)
Blocks: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md)

## Question

What is the exact contract for a pipeline stage — the function signature, async
policy, error handling, and what a custom (user-supplied) stage must export?

Draft based on charting decisions:

```js
// A stage is a plain function. Sync or async — the runner awaits all.
// Returns a numeric delta (positive = more risk, negative = less risk).
// chunk: the raw diff chunk (file, added, removed, op, newStart, …)
// ctx:   the pre-fetched signal context bag (see Signal Context Schema)
export default function myStage(chunk, ctx) {
  return ctx.churn * myWeight;
}

// Optional: metadata the runner uses for display and config validation.
export const meta = {
  name: "myStage",   // must match the "name" in pipeline config if built-in
  params: {          // JSON Schema fragment describing accepted inline params
    weight: { type: "number", default: 40 }
  }
};
```

**What to decide here:**
1. Sync vs async — force sync (simpler runner), allow async (needed if a stage
   wants to do its own I/O), or disallow I/O in stages entirely (all I/O is
   pre-fetched by the runner)?
2. Error handling — if a stage throws, does the runner: skip that stage and log,
   treat the chunk as risk=0 for that stage, or abort the whole pipeline?
3. Is `meta` mandatory or optional?
4. How does the runner pass inline params from the config to the stage? Via a
   factory (`createStage(params) → stageFn`) or a third argument
   (`stage(chunk, ctx, params)`)?
5. What module format? ESM only, or CJS support too?
