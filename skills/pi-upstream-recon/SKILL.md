---
name: pi-upstream-recon
description: Investigate the vendored pi packages' real API surface (pi-ai, pi-agent-core, pi-tui) before hand-rolling anything, and run pi version bumps safely. Use before implementing anything runtime/provider/TUI-shaped, when pi behavior is surprising, or when asked to "bump pi".
---

# pi upstream recon

Standing rule: **prefer native upstream implementations.** Before hand-rolling
runtime/provider/session/compaction/TUI machinery, check whether pi already
ships it — and check the LATEST version's API, never memory of an old one.

This rule is not pi-specific — it applies to **any** provider adapter. Before
hand-rolling output-shape recovery (JSON repair, retry-on-malformed,
`parseJsonLoose`/`parseJsonExact`-style scanners) for a provider, check that
provider's native structured-output / JSON mode first. The memory package
hand-rolled `parseJsonLoose`/`parseJsonExact` in `packages/memory/src/bujo/json.ts`
instead of setting Ollama's `format: "json"` on the `/api/generate` request in
`ollama-llm.ts` — the native flag constrains the model to valid JSON at the
source, which is strictly better than repairing malformed output after the fact.

## Locate the vendored source

```bash
cd "$(git rev-parse --show-toplevel)"
PIAI=$(ls -d node_modules/.pnpm/@earendil-works+pi-ai@*/node_modules/@earendil-works/pi-ai | head -1)
grep -m1 version "$PIAI/package.json"
sed -n '1,60p' "$PIAI/dist/types.d.ts"

D=$(dirname $(find node_modules/.pnpm -name "agent-harness.d.ts" -path "*pi-agent-core*" | head -1))
grep -rn "<symbol>" "$D"
# packages also nest their own copy:
grep -rn "<symbol>" packages/agent-runtime/node_modules/@earendil-works/pi-agent-core
```

Check what upstream has published:

```bash
npm view @earendil-works/pi-agent-core versions --json --registry https://registry.npmjs.org/ | tail -8
npm view @earendil-works/pi-ai@latest version exports --registry https://registry.npmjs.org/
```

## Version pins (do not "unify" them)

- `packages/agent-runtime`: `@earendil-works/pi-ai` + `pi-agent-core` at `^0.80.3`
- `packages/tui`: `@earendil-works/pi-tui` at `^0.79.1` — **intentionally behind**;
  the 0.80 pi-tui API breaks the TUI. Bumping it is its own project.

## Bump procedure

1. Edit the pins in the package manifests → `pnpm install`.
2. Read the new `.d.ts` diff for the surfaces we bridge (Session, AgentHarness,
   compaction, auth, provider registration) — pi minor bumps HAVE shipped
   behavior changes: 0.79.1 had no built-in compaction (bridge drives
   `harness.compact()`); 0.80 changed Models-auth and reports provider failures
   as a terse "Connection error." during failover.
3. Targeted tests first:

```bash
pnpm --filter @mono-agent/agent-runtime test -- src/__tests__/ai/pi-native.test.js \
  src/__tests__/pi-auth.test.js src/__tests__/ai/failure.test.js \
  src/__tests__/ai/router.test.js --runInBand
```

4. Full gate (`verify-green` skill), then live smoke (`live-smoke` skill) with a
   real pi model — pi regressions are exactly the class unit tests miss.

## Vendoring & pin guards

- **License consistency across the vendoring boundary.** `agent-runtime` is
  designed to be vendored-as-source into a second host (worklab), and it is the
  one workspace package licensed `GPL-3.0-only` while every other package is
  `UNLICENSED`. When auditing or porting anything across that boundary, diff the
  `license` field on both sides before treating a "wrap a copyleft kernel behind
  a differently-licensed facade" pattern as settled — each `package.json` is
  internally consistent even when the cross-boundary metadata is not:

```bash
grep -H '"license"' packages/agent-runtime/package.json packages/agent-app/package.json
# agent-runtime => GPL-3.0-only ; agent-app (and every other package) => UNLICENSED
```

- **`minimumReleaseAge` must be set before an exclude means anything.**
  `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` (pi + the `claude-agent-sdk`
  platform binaries) only does something if a global `minimumReleaseAge` cooldown
  is actually configured; without it the exclude is inert from the moment it is
  added. Confirm the cooldown is nonzero **before** adding or trusting an exclude
  entry:

```bash
pnpm config get minimumReleaseAge   # must be nonzero; today it returns `undefined` — the exclude is currently inert
```

## Reading discipline

- Trust `dist/*.d.ts` + shipped JS in `node_modules/.pnpm`, not blog-level memory.
- When behavior differs from types, read the shipped implementation:

```bash
JS=$(find node_modules/.pnpm -name "agent-harness.js" -path "*pi-agent-core*" | head -1); sed -n '1,40p' "$JS"
```

- Record any new gotcha in a memory note; pi surprises recur.
