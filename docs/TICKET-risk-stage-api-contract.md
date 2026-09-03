# Stage API Contract

Type: **grilling + prototype**
Blocked by: [Signal Context Schema](TICKET-risk-signal-context-schema.md)
Blocks: [Built-in Stage Catalog](TICKET-risk-builtin-stages.md)
**Status: RESOLVED**

## Resolution

Stages are factories. Async allowed. Failed stages skip with a warning (delta = 0).

### Contract

```js
/**
 * A pipeline stage module must export a default factory function.
 * The factory is called ONCE at startup with the inline params from the
 * config entry. It returns the actual stage function, which the runner
 * calls once per chunk.
 *
 * @param {Record<string, unknown>} params  Inline params from config entry.
 *   Built-in stages define which params they accept (and their defaults).
 *   Unknown params are ignored.
 * @returns {(chunk: Chunk, ctx: SignalContext) => number | Promise<number>}
 */
export default function create(params) {
  // Pre-compile, validate, close over params here — called once.
  const weight = params.weight ?? 40;
  return function stage(chunk, ctx) {
    // Return a numeric delta. Positive = more risk, negative = less risk.
    // ctx fields are frozen; do not attempt to mutate them.
    // Missing git signals arrive as null — use `?? 0` to treat as zero.
    return (ctx.churn ?? 0) * weight;
  };
}

// Optional but recommended: metadata for display and config validation.
export const meta = {
  name: "myStage",    // must match config "name" for built-in stages
  params: {           // JSON Schema fragment; used for validation + --list-presets
    weight: { type: "number", default: 40 },
  },
};
```

### Runner behaviour

- Factory called once per pipeline load (`create(params)`); the returned function is cached and reused for every chunk.
- Runner calls `await stageFn(chunk, ctx)` — sync stages work fine; async stages are supported.
- If the factory throws (bad params) or the stage function throws (runtime error): log a warning to stderr with stage name + error message, treat delta as 0, continue. The walk is never aborted for a single bad stage.
- `ctx` is `Object.freeze`d before the first stage is called; mutations throw in strict mode.
- Stage order matches declaration order in the pipeline array; final risk = sum of all deltas.

### Module format

ESM only (`.mjs` or `"type": "module"` in `package.json`). CJS not supported — mrp is ESM-only.

---

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
