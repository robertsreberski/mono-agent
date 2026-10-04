---
name: pi-upstream-recon
description: Investigate the vendored pi packages' real API surface (pi-ai and pi-agent-core) before hand-rolling anything, and run pi version bumps safely. Use before implementing runtime/provider/session behavior, when pi behavior is surprising, or when asked to "bump pi".
---

# pi upstream recon

Standing rule: **prefer native upstream implementations.** Before hand-rolling
runtime/provider/session/compaction machinery, check whether pi already
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

## Version pins (keep them exact)

- `packages/agent-runtime`: `@earendil-works/pi-ai` at `1.0.1`; `pi-agent-core` at `1.0.1`.
  Pi 1.x removed the experimental upstream harness. The runtime-owned harness
  migration permits lifting the former Renovate `<1.0.0` cap; future updates
  still require the exact-pin and packed-consumer resolution checks.
  Pi 0.85 replaces the old constructor/session surface with
  `AgentHarness.create()`, explicit operation `Context` arguments, and
  lane-scoped prompt, navigation, compaction, and event APIs. Keep that
  translation inside `src/ai/providers/pi-native/harness-adapter.js`.
  Pi 0.86 folds request prompts and tool declarations into the transcript's
  leading system message: provider-facing code (including faux response
  factories in tests) sees a `TranscriptContext` and must replay tools/prompt
  with `getCurrentTools()`/`getCurrentSystemPrompt()`, never `context.tools` /
  `context.systemPrompt`. Pi 0.86.1 also ships `opencode-go:deepseek-v4.1-flash`
  natively (the mono-agent catalog backfill is removed) and adds static `meta`
  and `radius` provider catalogs (41 static ids). Pi 0.87.0 removes
  `shouldStopAfterTurn` from the low-level `AgentLoopConfig`, replaced by
  `finishTurn` — but NEITHER hook is surfaced on `AgentHarnessOptions`
  (`dist/harness/agent-harness.d.ts`), so the pi-native bridge keeps enforcing
  the maxTurns ceiling locally in `stream-subscriber.js`. Pi 0.87.0 also stops
  sending strict tool schemas to unknown OpenAI-compatible Chat Completions
  endpoints (`supportsStrictMode` defaults false; capable built-ins keep strict
  tools via catalog `compat`): mono-agent's custom-provider `compat` never
  advertised strict support, so no bridge change. The new catalog
  `inputLimits.images` resize metadata is unread by mono-agent (vision still
  keys off `input` including `"image"`; attachment resizing stays Sharp-owned).
- Pi 0.87.1 ships `anthropic:claude-opus-5-5` and `gpt-6-sol`/`gpt-6-luna`
  on both `openai` and `openai-codex` natively, so no runtime supplement or
  OAuth identity patch is needed for those rows. Sol/Luna have a 272,000-token
  context window and priced tier above 272,000 input tokens; Opus 5.5 exposes
  low through max efforts. Anthropic OAuth sends Claude Code 2.1.280 upstream.
  Pi 0.99.1 ships `anthropic:claude-sonnet-5-5` natively with the same
  1M context, 128K output, $2/$10 base pricing, and low-through-max
  adaptive effort as the retired supplement. `off`/`minimal` remain unavailable;
  Pi does not emit a `between_tools` replacement for disabled thinking.
  Its generated v6 catalog has chat, image and classifier entries; unqualified
  `getBuiltinModel(s)` and `Models.getModel(s)` still return chat only.
  `gpt-6.1-sol` appears on `openai`, `openai-codex` and
  `azure-openai-responses`; do not change the default route to adopt it.
  Pi also retires chat rows such as `opencode-go:kimi-k2.6`, `glm-5.1`,
  `qwen3.6-plus` and `qwen3.7-max`; existing routes must switch to listed
  models or doctor reports a catalog miss. `openai-codex` keeps its id while
  its display name becomes "OpenAI Codex (legacy)". The new `openai` ChatGPT
  OAuth flow needs a stable installation device ID; mono-agent's app-owned
  Pi-auth-directory identity supplies it to the runtime auth facade and onboarding.
  API keys and Codex OAuth retain their separate paths. AgentHarness's public
  create/prompt/compaction/abort/wait surface is unchanged; Agent Core adds
  optional provider stream events and assistant `thinkingLevel` metadata.
- Pi's standalone OAuth registry remains unavailable at runtime.
  `packages/agent-runtime/src/ai/pi-oauth-compat.js` owns the compatibility
  surface over `provider.auth.oauth`; do not bypass it with private upstream
  imports.
- Importing projects should not add their own Pi dependency merely to read
  built-in models, reasoning levels, or OAuth helpers. Use the
  runtime-owned façade exported from `@mono-agent/agent-runtime/ai`:
  `listPiBuiltinModels`, `getPiBuiltinModel`, `reasoningLevelsForPiModel`,
  `resolvePiOAuthApiKey`, and `loginPiOAuth`. The model APIs return cloned
  snapshots, and the OAuth APIs do not expose Pi provider instances.
  A consumer test that still imports Pi's faux helpers must use an isolated
  fixture or the runtime's exact Pi AI `1.0.1` and Pi Agent Core `1.0.1`
  compatibility pins as development-only pins; a floating
  host range can otherwise satisfy Pi Agent Core's upstream dependency with a
  different copy.
- Pi Core 1.0 removes AgentHarness and SessionRepo. The Pi-native adapter now
  uses the mono-agent harness over the pinned `runAgentLoop`, not a fork of that loop.
  Compaction helpers retain the attributed old cut/estimator for parity.
  The mono-agent harness in `@mono-agent/harness` uses `mono-v2/journals`: import idle legacy v3/v4 main context once, fsync
  the new transcript before archiving the source, and cold-replay legacy files
  with open operations. Never test migration against real session directories.
- A packed consumer should resolve Pi AI `1.0.1` from both the runtime and Pi
  Agent Core. The release guard verifies both resolution paths independently so
  Core's upstream floating range cannot be rewired by a host dependency.

Pi AI's transitive provider SDK versions are upstream-owned. Do not force
deduplication across independently published consumers or override the lockfile
by hand.

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
  designed to be vendored-as-source into a second host (worklab). Mono-agent's
  root and all publishable workspace packages are deliberately aligned on
  `GPL-3.0-only`; keep that alignment explicit when auditing or porting across
  the boundary. Run the repository guard, then compare the target host's
  metadata before treating a copied kernel as license-compatible:

```bash
pnpm run check:licenses
grep -H '"license"' packages/agent-runtime/package.json packages/agent-app/package.json
# both => GPL-3.0-only
```

- **A release-age policy must be explicit across supported pnpm majors.** pnpm 10
  defaults `minimumReleaseAge` to 0 while pnpm 11 defaults it to 1440. The workspace
  therefore requires pnpm 10.16 or newer and commits `minimumReleaseAge: 0` to
  disable the cooldown consistently. It carries no `minimumReleaseAgeExclude`.
  Never infer the effective default from an
  `undefined` config read. If a future change enables a positive cooldown, commit any
  narrowly justified exclusions beside it and enforce the selector's pnpm floor:
  bare package names require 10.16, `*`/leading-`!` patterns require 10.17, and
  version-specific or disjunction selectors require 10.19. Either an exact
  `packageManager` pin or an
  adequate `engines.pnpm` lower bound can enforce that floor for local installs.
  Run the repository preflight rather than trusting raw config output:

```bash
node scripts/pnpm-release-age-policy.mjs
pnpm config get minimumReleaseAge          # explicit `0` while cooldown is disabled
pnpm config get minimumReleaseAgeExclude   # `undefined` while no exclusions are claimed
```

## Reading discipline

- Trust `dist/*.d.ts` + shipped JS in `node_modules/.pnpm`, not blog-level memory.
- When behavior differs from types, read the shipped implementation:

```bash
JS=$(find node_modules/.pnpm -name "agent-harness.js" -path "*pi-agent-core*" | head -1); sed -n '1,40p' "$JS"
```

- Record any new gotcha in a memory note; pi surprises recur.
