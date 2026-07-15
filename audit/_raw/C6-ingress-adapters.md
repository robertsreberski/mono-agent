# C6-ingress-adapters — webhook, cron, openai-api & operator adapters

## 1 Verdict & maturity grade

**Overall: B.** All four packages are small, dependency-clean, well-isolated per the "lean core" premise, and share a consistent structural-responder pattern (`AgentResponder` + `AgentMessageStream`) with real defensive engineering: graceful-abort watchdogs, per-run isolation, prototype-pollution-safe metadata sanitization, and (in cron's case) a genuinely well-fixed and regression-tested double-fire bug (PR #209 heritage). Real `vitest --coverage` runs (not estimates) show healthy statement coverage across the board — see Coverage verification below, which **refutes** the recon hints that operator-adapter and openai-api-adapter sit at ~0.36/0.40. The grade is held back by one flatly incorrect README claim in cron-adapter (a P1) and a cluster of P2 documentation/parity/coverage gaps repeated across siblings.

Per-package grades:

- **webhook-adapter: B+.** Multi-endpoint routing, per-endpoint model/effort override precedence, `maxRunMs` watchdog, and a careful `jsonSafeSnapshot` sanitizer defending against getter/prototype tricks in third-party responder metadata are all well done and well tested (90.17% real statement coverage, 49 tests). Docked for a stale doc reference (F7) and being the one HTTP adapter with no built-in auth option (F9, though honestly disclosed).
- **cron-adapter: B-.** The scheduler code itself is excellent — the early-wake/timer-coalescing fix is regression-tested exactly against the production symptom (67 tests, 90.05% coverage) — but the README **actively contradicts** the shipped, tested `overlap:"queue"/"replace"` feature (F1, P1) and never documents the safety-critical `toCronJobs()` (F3). Docs this wrong on a core capability pull the grade down despite strong code.
- **openai-api-adapter: B+.** Broad, thoughtfully engineered OpenWebUI compatibility surface (wildcard-host origin discovery, image attachment bridging, latest-turn extraction, tool-call rendering) with 86.86% coverage (52 tests). Docked for silently-inert sampling parameters (F4) and an unbounded SSE tool-result size (F6).
- **operator-adapter: B-.** Both sub-adapters (tui, live) are solid, but this is genuinely the weakest-tested of the four in real coverage (81.76%, driven mostly by the `live/` half), and it is the only sibling missing a dedicated config test file entirely (F5) — a real, concrete asymmetry versus its own `tui/` sibling in the same package.

This part has no live-instance scope (packages + READMEs only), so no separate Framework-fit grade applies.

### Coverage verification (real `vitest run --coverage`, not the recon estimate)

| Package | Statement % | Branch % | Test files | Tests |
|---|---|---|---|---|
| webhook-adapter | 90.17% | 82.24% | 3 | 49 |
| cron-adapter | 90.05% | 84.16% | 4 | 67 |
| openai-api-adapter | 86.86% | 75.17% | 2 | 52 |
| operator-adapter | 81.76% | 80.61% | 4 | 38 |

The recon hint that operator-adapter and openai-api-adapter sit at "test:src 0.36 / 0.40" does not hold up under an actual coverage run (`npx vitest run --coverage --coverage.include='packages/<pkg>/src/**' packages/<pkg>/src`) — both are healthily covered. Operator-adapter *is* directionally the weakest of the four, which is correct, just not by that margin. The recon hint's number appears to be a crude line-count ratio (test-file lines ÷ src-file lines) rather than actual code coverage; a raw line-ratio for operator-adapter (756 test lines ÷ 1143 src lines ≈ 0.66) still doesn't reproduce 0.36 either, so the figure should be treated as unverified going forward.

### Focus question: webhook/openai-api binding defaults

The **code-level default is safe** across all four packages: every one binds `127.0.0.1` by default, and each of webhook, openai-api, tui, and live calls `assertSafeBind(host, allowNonLoopback, ...)` before `listen()`, refusing any non-loopback host unless `allowNonLoopback: true` is explicit. openai-api-adapter additionally requires an `apiKey` for any non-loopback bind (`config.ts:57-62`, `server.ts:173-179`). The one place `0.0.0.0` appears in the codebase is a **documentation example** (`docs/playbooks/openai-endpoint-open-webui.md:40`), which correctly pairs it with `allowNonLoopback: true` and an explicit `:::caution` callout about the required API key — this is a guarded, deliberate opt-in pattern, not an unsafe default. See F2 below for a real, narrower asymmetry this investigation surfaced: only openai-api-adapter re-validates the *actual OS-resolved* bind address after `listen()` resolves; its three siblings do not.

## 2 Findings

**F1 (P1) — cron-adapter's README flatly contradicts its own shipped, tested overlap feature.**
`packages/cron-adapter/README.md:34`:
```
Only future ticks after startup are scheduled. Overlapping runs for the same job are skipped, not queued or run concurrently.
```
`packages/cron-adapter/README.md:87`:
```
It does not build prompts, run models, persist missed runs, catch up after restart, queue overlapping jobs, expose UI, or define core core agent settings.
```
But `packages/cron-adapter/src/scheduler.ts:55` defines `export type CronOverlapMode = "queue" | "skip" | "replace";` with a fully implemented `maxQueueDepth`/`overflow` policy (`scheduler.ts:282-362`), and this exact feature is covered by dedicated, passing tests (`cron-adapter.test.ts:223,551,558` for `queue`; `:347-451` for `replace`). The README doesn't merely omit the feature — line 87 explicitly disclaims it ("does not... queue overlapping jobs"). A host integrator following only the README would conclude they must hand-roll queuing, or would avoid mono-agent for a use case it already supports. This directly violates the "crons... easily" and legibility clauses of the premise: the core documentation must be trustworthy for "a competent stranger."

**F2 (P2) — Only openai-api-adapter re-validates the actual bound address after `listen()`; webhook/tui/live do not.**
`packages/openai-api-adapter/src/server.ts:307-323`:
```ts
const boundNonLoopback = !isLoopbackHost(address.address);
if (boundNonLoopback && options.allowNonLoopback !== true) {
  await closeRejectedServer();
  throw new OpenAIApiAdapterError("unsafe_host", ...
```
This defends against the OS resolving a configured `host` string to an unexpected concrete address after `assertSafeBind`'s pre-bind, string-based check has already passed. `packages/webhook-adapter/src/server.ts`, `packages/operator-adapter/src/tui/server.ts`, and `packages/operator-adapter/src/live/server.ts` all call `assertSafeBind` before `listen()` in the identical pattern, but none of them re-checks `address.address` afterward — they proceed straight from `listen()` to building the returned URL. This is a genuine, cheaply-fixable asymmetry in an otherwise-consistent safety mechanism across four sibling HTTP adapters.

**F3 (P2) — `toCronJobs()` is a safety-critical, footgun-guarded public function, entirely absent from the README.**
`packages/cron-adapter/src/config.ts:167-172`:
```ts
/**
 * Project the loaded config down to the runtime {@link CronJob} shape consumed
 * by {@link import("./scheduler.js").startCronAdapter}, dropping disabled jobs.
 * Hosts must route config jobs through this rather than spreading them directly,
 * otherwise the `enabled` flag is silently ignored and disabled jobs would run.
```
It is exported from `packages/cron-adapter/src/index.ts:28`, yet `grep -n "toCronJobs" packages/cron-adapter/README.md` returns nothing — the README's "Public API" list (lines 69-79) never mentions it. A reader who only skims the README (the primary onboarding path per the premise) would not learn this function exists, let alone that skipping it silently runs disabled jobs.

**F4 (P2) — openai-api-adapter validates and forwards OpenAI sampling parameters that are never applied anywhere in the shipped codebase.**
`packages/openai-api-adapter/src/server.ts:978-996` (`readParameters`) extracts `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `stop`, `seed`, `logit_bias`, `presence_penalty`, `frequency_penalty` into `metadata.openaiApi.parameters` on every chat request. A repo-wide search (`grep -rln "temperature" packages/*/src/**/*.ts`, excluding tests) shows this string appears **only** in `openai-api-adapter/src/server.ts` — no consumer in `agent-app` or `agent-harness` ever reads `metadata.openaiApi.parameters` or applies these values to a model call. An OpenWebUI user adjusting the temperature slider gets a `200 OK` with the parameter silently discarded, with no error, warning, or documentation caveat about this — a genuine "honest ops" gap (config accepted but functionally inert).

**F5 (P2) — operator-adapter's `live/config.ts` has zero dedicated tests, unlike every sibling config module.**
`packages/operator-adapter/src/live/__tests__/` contains only `server.test.ts`; there is no `config.test.ts`. Its own siblings each have one: `packages/operator-adapter/src/tui/__tests__/config.test.ts` (103 lines, tests defaults/env-JSON layering/disable/malformed-basePath/**apiKey redaction**), `packages/openai-api-adapter/src/__tests__/config.test.ts`, `packages/webhook-adapter/src/__tests__/config.test.ts`. The only place `loadLiveAdapterConfig`/`redactLiveAdapterConfig` are touched at all is `packages/operator-adapter/src/__tests__/public-api.test.ts:27-28`:
```ts
expect(operatorAdapter.loadLiveAdapterConfig).toEqual(expect.any(Function));
expect(operatorAdapter.redactLiveAdapterConfig).toEqual(expect.any(Function));
```
— a `typeof` check, never invoked with real data. `redactLiveAdapterConfig` (`live/config.ts:72-81`) exists specifically to keep an `apiKey` secret out of config-view output; that exact call site is untested. Real coverage confirms the gap: `live/config.ts` sits at 84.37% with lines 73-81 (the redact function body) uncovered.

**F6 (P2) — openai-api-adapter's SSE tool-call rendering has no size cap, unlike the sibling TUI adapter's bounded truncation.**
`packages/openai-api-adapter/src/server.ts:1069-1097` (`openWebUIToolDetails`) embeds a tool call's raw `arguments`/`result` into an HTML `<details>` block written straight to the SSE stream, with no size limit. Compare `packages/operator-adapter/src/tui/server.ts:301-343` (`truncateEvent`), which caps any oversized tool/thought payload at `MAX_FRAME_BYTES / 2` before writing an NDJSON frame. A tool that returns a very large result (e.g. a large file read) would write one unbounded SSE `data:` line in the openai-api-adapter path, with no equivalent protection.

**F7 (P3) — three READMEs advertise a `*FieldGroup` export that does not exist anywhere in the codebase.**
`packages/webhook-adapter/README.md:82` (`` `webhookFieldGroup` ``), `packages/cron-adapter/README.md:78` (`` `cronFieldGroup` ``), `packages/openai-api-adapter/README.md:96` (`` `openAIApiFieldGroup` ``) each list this in their "Public API" section. `grep -rn "webhookFieldGroup\|cronFieldGroup\|openAIApiFieldGroup"` across each package's `src/` returns nothing. Per the user's own memory (`config-consolidation-recipes.md`: "deleted the zero-consumer field-group registry"), this is leftover doc debris from that deletion — `operator-adapter/README.md` (edited more recently) correctly has no such reference.

**F8 (P3) — the `telegram:`/`slack:` deliverable-conversation check is triplicated verbatim across three packages.**
`packages/webhook-adapter/src/server.ts:835-837`:
```ts
function isDeliverableConversation(conversationId: string): boolean {
  return conversationId.startsWith("telegram:") || conversationId.startsWith("slack:");
}
```
Identical logic exists at `packages/agent-app/src/channels.ts:1000-1001` and `packages/agent-harness/src/harness.ts:2667` (out of this part's file scope, but discovered while tracing this function's only in-scope call site at `webhook-adapter/src/server.ts:349`). No shared constant/helper backs any of the three; a future channel addition (e.g. WhatsApp gaining native-notify support) requires remembering to update all three copies, or two of three silently regress.

**F9 (P3) — webhook-adapter is the only HTTP-bearing sibling with no built-in `apiKey`/bearer-auth option.**
`packages/webhook-adapter/src/server.ts`'s `WebhookAdapterOptions` (lines 126-149) and `WebhookAdapterConfig` (`config.ts:35-49`) have no `apiKey` field and no `authorize()` function, unlike `openai-api-adapter` (`server.ts:105`, `authorize()` at 1034), `tui` (`config.ts:23`, `authorize()` at 385), and `live` (`config.ts:23`, `authorize()` at 255) which all support an optional bearer key checked via `bearerTokensEqual`. This is honestly disclosed — `webhook-adapter/README.md:91` and `docs/channels/webhook.md:57` both explicitly tell hosts to "put it behind a reverse proxy or auth layer you control" — but it is a real inconsistency: webhook is, by nature, the adapter most likely to need real external (non-loopback) exposure to receive third-party provider callbacks, yet it is the one with the least built-in defense-in-depth option.

**F10 (P3) — webhook-adapter has no per-endpoint `maxRunMs` override; cron-adapter has per-job override with a global fallback.**
`packages/webhook-adapter/src/server.ts:132-138` documents a single adapter-wide `maxRunMs` used by every endpoint's watchdog (`runResponder`, line 463: `input.options.maxRunMs`). `packages/cron-adapter/src/scheduler.ts:35-36` gives each `CronJob` its own optional `maxRunMs`, with `options.maxRunMs` as a shared fallback (`scheduler.ts:429`: `job.maxRunMs ?? options.maxRunMs`). The webhook README explicitly says the watchdog "mirrors the cron adapter" (`server.ts:458-462` comment), but the per-job/per-endpoint override parity is incomplete — a long-running research endpoint and a fast-invoke endpoint sharing one server cannot get different watchdog bounds today.

## 3 Dead code

None found in the four packages' `src/` trees. Every exported function traced back to either a real call site (host/app consumption, out of this part's scope but verified via repo-wide grep) or a test. The closest candidates were investigated and ruled out:
- `handleTick` (cron-adapter `scheduler.ts:282`) is deliberately internal-only (not re-exported from `index.ts`) but is imported directly by `cron-adapter.test.ts:9` for defense-in-depth regression testing of the unrecognized-overlap-mode fallback — not dead, by design.
- `CronJobConfig.notifyFailureCooldownHours` is validated/parsed in `cron-adapter/src/config.ts` and `jobs-dir.ts` but is intentionally **not** projected into the runtime `CronJob` shape by `toCronJobs()` — this is not a bug: `packages/agent-app/src/channels.ts:1143` reads it directly off the retained `CronJobConfig[]` (not the projected runtime jobs) for host-side failure-notice cooldown logic. Confirmed live, not dead.
- `RedactedWebhookAdapterConfig`/`RedactedCronAdapterConfig` are identity-transform types (these two configs hold no secrets) — this is a documented, intentional consequence of a uniform `redact*Config` pattern applied polymorphically across every channel adapter by the host, not dead code.

## 4 Deprecation & legacy

No `@deprecated` JSDoc tags exist anywhere in this part's scope (`grep -rn "@deprecated" packages/{webhook,cron,openai-api,operator}-adapter/src` — no hits). The only "legacy"-labeled surface is the single-endpoint/single-job backward-compatible config shape:
- `packages/webhook-adapter/src/config.ts:121` ("legacy `webhook.path`/`prompt`"), `packages/webhook-adapter/src/server.ts:141,145,785` ("legacy endpoint" synthesized from `path`/`defaultMode` when `endpoints` is omitted).
- `packages/cron-adapter/src/scheduler.ts:51,298` ("legacy behavior" = default `overlap:"skip"`).

None of these are removable — they are the primary single-endpoint/single-job on-ramp most simple agent configs still use (per `WEBHOOK_CONFIG_FIELDS`/`CRON_CONFIG_FIELDS` still treating the single-field form as the third-precedence fallback), and both are actively exercised by the test suites. Classification: **load-bearing, not deprecated for removal.**

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| C6-1 | Rewrite cron-adapter README lines 34 and 87 to accurately describe `overlap:"skip"/"queue"/"replace"` | README directly contradicts a real, tested feature — violates "crons... easily" + core legibility | Replace the two lines with a short paragraph naming all three modes, `maxQueueDepth`/`overflow`, and link to the `CronOverlapMode`/`CronOverflowPolicy` types | S | Reviewer confirms README text matches `scheduler.ts` behavior; no remaining "does not... queue" claim | y |
| C6-2 | Add openai-api-adapter's post-`listen()` bound-address re-check to webhook-adapter, tui, and live | Only 1 of 4 sibling HTTP adapters guards against the OS resolving `host` to an unexpected non-loopback address after bind | Port the `boundNonLoopback`/`closeRejectedServer` pattern (`openai-api-adapter/server.ts:307-323`) into the other three `startXAdapter` functions | M | New test per package: binding a hostname that resolves non-loopback without `allowNonLoopback` throws `unsafe_host` post-listen | n |
| C6-3 | Document `toCronJobs()` (with its footgun warning) in cron-adapter's README Public API section | It's a safety-critical function undocumented outside its own JSDoc | Add a bullet + one-paragraph callout in README.md | S | `grep -n "toCronJobs" packages/cron-adapter/README.md` succeeds | n |
| C6-4 | Either wire `metadata.openaiApi.parameters` (temperature/top_p/etc.) through to the model call, or explicitly document that they are accepted-but-inert | Silent no-op undermines "honest ops"; an OpenWebUI user's slider does nothing with zero signal | Short-term: add a README caveat + a `runtime_warning` stream event when non-default parameters are present but unsupported; longer-term: apply supported ones via the harness | M | README states the caveat explicitly; optional warning event covered by a new test | n |
| C6-5 | Add `packages/operator-adapter/src/live/__tests__/config.test.ts` mirroring `tui/__tests__/config.test.ts` | `live/config.ts` is the only sibling config module with zero direct tests, including untested secret redaction | Copy the tui pattern: defaults, JSON+env override, disable, malformed basePath, `redactLiveAdapterConfig` with a real key | S | New test file passes; `live/config.ts` line coverage reaches 100% (currently 84.37%, missing 73-81) | n |
| C6-6 | Cap tool-call argument/result size in openai-api-adapter's SSE `openWebUIToolDetails` output | Unbounded HTML block could balloon one SSE chunk on a large tool result; TUI already bounds the equivalent | Reuse/extract the TUI adapter's `MAX_FRAME_BYTES`-style truncation helper before `writeChunk` | M | New test: a >256KB tool result is truncated in the emitted SSE payload | n |
| C6-7 | Remove the stale `webhookFieldGroup`/`cronFieldGroup`/`openAIApiFieldGroup` bullets from the three READMEs | Dead references to a deleted field-group registry mislead integrators | Delete the one line in each README | S | `grep -rln "FieldGroup" packages/*/README.md` returns nothing | n |
| C6-8 | De-duplicate the `telegram:`/`slack:` `isDeliverableConversation` check into one shared helper | Same literal logic copy-pasted in webhook-adapter, agent-app, and agent-harness; a future channel add risks a silent partial update | Move the check into `agent-contracts` and import it at all three call sites | M | `grep` for the duplicated literal body returns exactly one definition | n |
| C6-9 | Add an optional `apiKey`/bearer-auth option to webhook-adapter for parity with its three siblings | Webhook is the adapter most likely to need real non-loopback exposure yet has zero built-in auth option | Add `apiKey` config field + `authorize()` mirroring `openai-api-adapter/server.ts` | M | Non-loopback webhook config test asserts 401 on missing/incorrect bearer token when `apiKey` is set | n |
| C6-10 | Add a per-endpoint `maxRunMs` override to webhook-adapter, matching cron's per-job override | Endpoints sharing one server currently cannot get different watchdog bounds; cron already supports this | Add `maxRunMs?` to `WebhookEndpointOption`/`WebhookEndpointConfig`; resolve `endpoint.maxRunMs ?? options.maxRunMs` in `runResponder` | S | New test: two endpoints with different `maxRunMs` timeout independently | n |

## 6 Skill-worthy flags

- **docs-sync amendment:** mechanically diff each package README's "Public API" bullet list against its `src/index.ts` actual named exports (a simple `grep`-per-bullet check) before merging any PR that touches an adapter's exports. This would have caught the `*FieldGroup` staleness in 3 READMEs simultaneously (all three date to the same deleted-registry PR) and the missing `toCronJobs` bullet. Concrete check: `node -e` or a shell loop that extracts backtick-quoted identifiers from a README's "## Public API" section and greps for each in the package's `dist/index.d.ts` or `src/index.ts`.
- **docs-sync amendment (behavior-prose drift):** when a PR adds a new opt-in mode/enum to a package (e.g. cron-adapter's `overlap:"queue"/"replace"`), grep the package's own README prose for a stale absolute claim (e.g. "does not... X", "always Y, never Z") that the new code just falsified. cron-adapter's README line 87 ("does not... queue overlapping jobs") is exactly this pattern — a "What This Package Does Not Own" boilerplate section that was true when the package was created and never revisited when the feature shipped.
- **new-package amendment (sibling test-shape parity):** when a package has two structurally-parallel sub-modules (operator-adapter's `tui/` and `live/`), diff their `__tests__/` directory listings before merging and flag any missing counterpart file (e.g. `live/` missing a `config.test.ts` that `tui/` has). This is exactly how `live/config.ts`'s secret-redaction path went untested while the identical shape in `tui/config.ts` is fully tested.

## 7 Coverage note

Files read in full (source, all four `src/` trees):
- `packages/webhook-adapter/src/config.ts`
- `packages/webhook-adapter/src/endpoints-dir.ts`
- `packages/webhook-adapter/src/index.ts`
- `packages/webhook-adapter/src/server.ts`
- `packages/webhook-adapter/README.md`
- `packages/cron-adapter/src/config.ts`
- `packages/cron-adapter/src/cron-expression.ts`
- `packages/cron-adapter/src/index.ts`
- `packages/cron-adapter/src/jobs-dir.ts`
- `packages/cron-adapter/src/scheduler.ts`
- `packages/cron-adapter/README.md`
- `packages/openai-api-adapter/src/config.ts`
- `packages/openai-api-adapter/src/constants.ts`
- `packages/openai-api-adapter/src/errors.ts`
- `packages/openai-api-adapter/src/index.ts`
- `packages/openai-api-adapter/src/server.ts`
- `packages/openai-api-adapter/README.md`
- `packages/operator-adapter/src/index.ts`
- `packages/operator-adapter/src/live/config.ts`
- `packages/operator-adapter/src/live/constants.ts`
- `packages/operator-adapter/src/live/errors.ts`
- `packages/operator-adapter/src/live/index.ts`
- `packages/operator-adapter/src/live/server.ts`
- `packages/operator-adapter/src/tui/config.ts`
- `packages/operator-adapter/src/tui/constants.ts`
- `packages/operator-adapter/src/tui/errors.ts`
- `packages/operator-adapter/src/tui/index.ts`
- `packages/operator-adapter/src/tui/server.ts`
- `packages/operator-adapter/README.md`

Test files skimmed for coverage adequacy (not line-by-line audited), plus real `vitest run --coverage` executed per package:
- `packages/webhook-adapter/src/__tests__/{config,endpoints-dir,webhook-adapter}.test.ts`
- `packages/cron-adapter/src/__tests__/{config,cron-adapter,cron-expression,jobs-dir}.test.ts`
- `packages/openai-api-adapter/src/__tests__/{config,openai-api-adapter}.test.ts`
- `packages/operator-adapter/src/__tests__/public-api.test.ts`
- `packages/operator-adapter/src/live/__tests__/server.test.ts`
- `packages/operator-adapter/src/tui/__tests__/{config,server}.test.ts`

Cross-package greps performed to verify claims (not full reads, cited as supporting evidence only): `packages/agent-app/src/channels.ts` (`isDeliverableConversation`, `notifyFailureCooldownHours`, `openaiApi` metadata consumption), `packages/agent-harness/src/harness.ts` (`isDeliverableConversation`), `docs/playbooks/openai-endpoint-open-webui.md`, `docs/channels/webhook.md` (auth/binding guidance context for the focus questions).

No named in-scope file was missing; all four packages' full `src/` trees and all four READMEs exist and were read.
