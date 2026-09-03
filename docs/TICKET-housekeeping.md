# Ticket: housekeeping — CI, stale docs README, docs index

Type: chore · Status: open · **Priority:** P2 (small, do anytime) · **Drafted:** 2026-09-02
**From:** `docs/IDEAS.md` §7

Three small items, bundled because none deserves its own spec.

## 1. CI workflow (repo is public now)

Add `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [master] }
  pull_request: {}
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}", cache: npm }
      - run: npm ci
      - run: npm test
```

Notes:
- `package.json` `engines` says `>=20`, so the matrix covers the declared floor
  plus current LTS/major — drop 24 if it flaky-tails, but try it first.
- Tests are `node --test`, no network, no fixtures on disk (hermetic temp dirs)
  — plain `npm test` is the whole job.
- `rg` (ripgrep): `fanOut` shells out to `rg`. Ubuntu runners ship ripgrep
  preinstalled (GitHub docs list it in installed software); `tests/risk.test.mjs`
  deliberately uses an EMPTY temp dir so rg errors are handled in-code —
  tests pass either way. Still, add `sudo apt-get install -y ripgrep` only if
  CI actually reds on it; don't preempt.
- Badge line in root README once green.

## 2. Delete `docs/README.md`

It's a stale duplicate of the root README (same content, no longer updated —
the root README evolved past it). Delete the file; the specs/tickets are
self-describing and discoverable as `docs/*.md`.

## 3. `docs/IDEAS.md` → link from root README

Add a `## Roadmap / ideas` line in the root README's "Known gaps / next"
section pointing at `docs/IDEAS.md` and the OPEN specs, so a repo visitor sees
where future work is tracked without grepping the docs dir.

## Steps

1. Commit CI workflow; verify first run green on GitHub.
2. `git rm docs/README.md`.
3. README roadmap line.

## Acceptance

CI green on master for the 3-node matrix; `docs/README.md` gone; root README
links the ideas/spec docs.
