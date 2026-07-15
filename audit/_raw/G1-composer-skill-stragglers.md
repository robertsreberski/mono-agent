# G1 — mono-agent-composer skill, srt resource, scripts/lib stragglers, root workspace configs

## 1 Verdict & maturity grade

**Grade: C+ (shippable, but the flagship "authoritative and exhaustive" claim is false in at least three concrete, verifiable places).**

The `mono-agent-composer` skill (`packages/agent-app/skills/mono-agent-composer/**`) is well-written, well-organized, and mostly accurate against v0.11.2 — CLI flags, preset ids, sandbox semantics, effort-keyword clamping, and the package-boundary rules all check out against the real source. But the skill's central premise (`SKILL.md:10-27`: *"The `references/*.md` … are complete for configuration and capabilities… Answer every 'can it do X?' … from them… Absence from the table means 'not configurable,' never 'go check the source'"*) is contradicted by its own reference files for at least three shipped, config-only, well-documented features: native cron/webhook `notify` delivery, per-trigger `model`/`effort` overrides, and the Supermemory memory backend. Because the skill explicitly forbids the composing agent from consulting `docs/reference/feature-registry.md` or the package source, a user going through the exact "cron digest" playbook this skill ships will be handed the *pre-PR#98, superseded* tool-call pattern instead of the现 canonical `notify: true` config, and will never learn the native-notify feature exists at all. That is a real regression in the quality of agents this skill composes, not a cosmetic doc gap.

The other three scope items are in materially better shape: `packages/agent-app/resources/srt/package.json` is a small, correct, integrity-locked artifact whose SHA-256 lock hash I verified matches the constant baked into `sandbox-manager.ts`; `scripts/lib/build-provenance.mjs` and `scripts/lib/memory-cleanup-calibration.mjs` are both real, actively consumed infrastructure (not dead code); and the root `vitest.config.mjs` / `website/pnpm-workspace.yaml` are small, well-commented, and consistent with the dual-workspace story.

## 2 Findings

### P1 — composer skill is missing the native cron/webhook `notify` feature entirely

`references/feature-coverage.md` (self-described "authoritative, exhaustive" at line 3) and `references/config-blueprint.md`'s annotated `cron`/`webhook` sections (`config-blueprint.md:267-281`, `175-184`) never mention `notify`, `notifyConversationId`, or `notifyFailureCooldownHours`. Yet these are real, shipped fields:

```
packages/cron-adapter/src/config.ts:25-28
  readonly notify?: boolean;
  readonly notifyConversationId?: string;
  readonly notifyFailureCooldownHours?: number;
```

and are documented at length in the canonical, in-repo reference the skill tells composing agents *not* to read:

```
docs/reference/feature-registry.md:134
| `channel.native-notify` | Opt-in per cron job / webhook endpoint via `notify: true`. ...
```

**Failure scenario:** a user asks the composer for "a cron job that posts a daily Slack digest" (exactly `references/playbooks.md`'s playbook #1 scenario). The composer, restricted to its bundled references, has no way to discover `notify: true` exists, and will fall back to the older `SlackSendMessage`-tool pattern (see next finding) — a strictly worse, more error-prone config for a feature the framework built a first-class primitive for.

### P1 — playbooks.md's cron-digest playbook teaches the superseded pre-notify pattern, contradicting its own "mirrors the published Playbooks index" claim

`references/playbooks.md:1-10` states the file "Mirrors the published Playbooks index (<https://mono-agent-docs.vercel.app/playbooks/>)." The real, current playbook at that URL's source is `docs/playbooks/cron-digest-proactive-notify.md`, titled **"Cron Digest with Native Notify"**, and it is entirely built around `notify: true` / `notifyConversationId` with **no tool call**:

```
docs/playbooks/cron-digest-proactive-notify.md:9
On a schedule, the agent builds a daily digest ... and `mono-agent` delivers that
final answer **verbatim** through native notification.
```

But `references/playbooks.md`'s playbook 6 ("Cron digest with proactive Slack notify", `playbooks.md:101-115`) still uses the old superseded shape:

```
packages/agent-app/skills/mono-agent-composer/references/playbooks.md:110-111
"tools": { "allowedTools": ["SlackSendMessage", "WebSearch"] },
"cron": { "jobs": [{ ... "prompt": "Build the morning digest and post it to #team via SlackSendMessage." ...
```

This is not a cosmetic mismatch — per user MEMORY (`native-cron-notifications.md`), the `notify_conversation` tool this pattern resembles was **deleted** in PR #98 in favor of exactly the native-notify mechanism the real playbook now demonstrates. The composer's mirrored copy is one full feature-generation behind the doc it claims to mirror.

### P1 — `runtime.per-trigger-model` (per-cron-job / per-webhook-endpoint model+effort override) is undocumented in the composer skill

Real, shipped fields:

```
packages/cron-adapter/src/config.ts:29-32
  /** Per-job runtime model override (e.g. `claude:claude-opus-4-8`). Validated by the app. */
  readonly model?: string;
  /** Per-job reasoning effort override (e.g. `high`). Validated by the app. */
  readonly effort?: string;
```
(identical shape in `packages/webhook-adapter/src/config.ts:29-32`), documented canonically at:
```
docs/reference/feature-registry.md:135
| `runtime.per-trigger-model` | Per-cron-job and per-webhook override of runtime model/effort. ...
```

Neither `references/feature-coverage.md`'s Channels table (`feature-coverage.md:70` for cron, `:60` for webhook) nor `references/config-blueprint.md`'s annotated `cron`/`webhook` blocks mention `model`/`effort` at the job/endpoint level. A user asking "can I run this one cron job on a stronger model than the rest?" gets a false "not configurable" answer from a skill whose own operating rule (`SKILL.md:16`) says absence from the table means exactly that.

### P2 — `references/package-map.md` never mentions `@mono-agent/session-web`, the package that implements `mono-agent web`

`mono-agent web` (the Session Recorder PWA) is referenced repeatedly elsewhere in the same skill (`config-blueprint.md:303`, `SKILL.md`, `feature-coverage.md:83`), but `package-map.md`'s "Observability Join" section (`package-map.md:108-116`) lists only `@mono-agent/tui`, `@mono-agent/operator-adapter`, and `@mono-agent/observability` — `@mono-agent/session-web` (confirmed as its own `operator-surface` package in `PACKAGES.md`'s "Current Packages" table and `scripts/package-catalog.mjs`) is absent from the very map whose stated purpose is "which package owns what … for programmatic composition and troubleshooting" (`package-map.md:1-3`). Compounding this, `feature-coverage.md:83`'s entry for the web PWA lists only `[--host] [--port] [--no-open] [--allow-non-loopback] [--include-memory]` and omits `--show-auth-url`, `--max-runs`, and the `MONO_AGENT_WEB_AUTH_TOKEN` requirement that non-loopback binding now needs per `docs/reference/feature-registry.md:158` — a security-relevant gap for anyone the composer walks toward `openaiApi`/non-loopback style exposure and who also wants `mono-agent web`.

### P2 — Supermemory backend (`memory.backend`, `@mono-agent/memory-supermemory`) is undocumented in feature-coverage.md and package-map.md despite being demonstrated in the skill's own playbook

`references/playbooks.md` playbook 13 ("Personal Telegram assistant with Supermemory", `playbooks.md:218-236`) tells the user to "install the exact `@mono-agent/memory-supermemory` version matching agent-app" and write `"memory": {"backend": "supermemory", ...}`. This is a real config field (`packages/config/src/types.ts:254: readonly backend?: MemoryBackend;`) and a real, cataloged plugin-tier package (`scripts/package-catalog.mjs`, `PACKAGES.md`). Yet neither `references/feature-coverage.md`'s "Context, skills, memory" table (lines 22-39) nor `references/package-map.md`'s "Context And Skill Join" table (lines 43-56) mentions `memory.backend` or `@mono-agent/memory-supermemory` at all. A capability the skill's own playbook depends on is invisible in the two tables that are supposed to be the exhaustive answer to "can it do X" and "which package owns it."

### P2/P3 — `config-blueprint.md`'s `runtime.effort` comment documents only 6 of the real 8 enum values

```
packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md:38
"effort": "medium",  // none|low|medium|high|xhigh|max; omit for direct opencode:*
```

The real enum (`packages/config/src/enums.ts:10`) is `["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]` — `minimal` and `ultra` are both missing from the composer's comment, even though both are legitimate, documented, settable values (`docs/config/blueprint.md:57`, `docs/config/env-vars.md:41`, `docs/reference/feature-registry.md:135`). Lower severity than the notify/per-trigger gaps because it's a single inline comment rather than a whole missing capability, but it means a user who asks "what effort levels exist?" gets an incomplete answer from the one file the skill says to trust over source.

## 3 Dead code

None found in this scope. Specifically:

- `scripts/lib/build-provenance.mjs` is **not** orphaned — it backs the root `build` script (`package.json:13`: `"build": "node scripts/build-with-provenance.mjs"`), and is imported by `scripts/build-with-provenance.mjs`, `scripts/build-provenance-probe.mjs`, `scripts/fleet-green-check.mjs`, `scripts/release/publish-release.mjs`, and has its own test (`scripts/__tests__/build-provenance.test.mjs`). It is load-bearing build/release/fleet-deploy integrity infrastructure (git-sha + output-digest + dependency-digest attestation), not a straggler.
- `scripts/lib/memory-cleanup-calibration.mjs` is **not** orphaned — it is imported by `scripts/memory-benchmark.mjs`, which is wired to the root script `"benchmark:memory": "pnpm --filter '@mono-agent/memory...' run build && node scripts/memory-benchmark.mjs --gate"` (`package.json:26`). It is not run in any `.github/workflows/*.yml` (grepped, zero hits), so it is dev-invoked quality-calibration tooling rather than an automated CI gate — worth noting as a freeze-adjacent observation (a recall/graph-quality regression could land without CI catching it) but not dead code.

## 4 Deprecation & legacy

- The `recipes` → `presets` rename and `--recipe` → `--preset` deprecated-alias story documented in `feature-coverage.md:84` (*"`recipes`/`--recipe` deprecated aliases"*) is accurate: confirmed in `packages/agent-app/src/cli.ts:144,273-282,3416-3420` — `recipes` normalizes to `presets`, `--recipe` resolves through `RECIPE_TO_PRESET` with a deprecation hint. No drift here.
- `packages/agent-app/resources/srt/package.json` (`@mono-agent/managed-srt`, pinned `@anthropic-ai/sandbox-runtime@0.0.64`) is consistent with the managed-SRT story: `MANAGED_SRT_VERSION = "0.0.64"` and `MANAGED_SRT_LOCK_SHA256` in `packages/agent-app/src/sandbox-manager.ts:45-47` match the shipped `package.json`/`package-lock.json` exactly — I independently recomputed `shasum -a 256` on `package-lock.json` and it equals the constant byte-for-byte. This is a correctly-maintained integrity-locked install input, not legacy cruft.
- `vitest.config.mjs` (root) and `website/pnpm-workspace.yaml` are both small, purpose-built, and match their own in-file comments against the actual repo layout (verified `.ultrawork/` and `.worklab-tmp/` are the real gitignored worktree-copy directories the root vitest exclude list targets; verified the root `pnpm-workspace.yaml` `packages: ["packages/*","extras/*"]` deliberately excludes `website/`, matching `website/pnpm-workspace.yaml`'s own stated rationale of an isolated Vercel-deployable docs app). No inconsistency found.

## 5 Actionable steps

| ID | What | Why | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| G1-1 | Add `notify`/`notifyConversationId`/`notifyFailureCooldownHours` to `feature-coverage.md`'s cron/webhook rows and to `config-blueprint.md`'s annotated `cron`/`webhook` blocks | Real shipped feature invisible to a skill that forbids checking source; directly undercuts the "exhaustive" claim | Copy the field list + one-line semantics from `docs/reference/feature-registry.md:134` into both composer reference files | S | Composer skill's cron/webhook sections mention `notify` and cite the destination-resolution rule | y |
| G1-2 | Rewrite `playbooks.md` playbook 6 to use `notify: true` + `notifyConversationId` instead of the `SlackSendMessage` tool-call pattern, matching `docs/playbooks/cron-digest-proactive-notify.md` | Skill claims to mirror the published playbook and currently teaches the superseded pattern for the flagship notify feature | Port the JSON block and prompt wording from the canonical doc playbook | S | Diffed against `docs/playbooks/cron-digest-proactive-notify.md`; no `SlackSendMessage` tool call remains in that playbook entry | y |
| G1-3 | Add `runtime.per-trigger-model` (`cron.jobs[].{model,effort}`, `webhook.endpoints[].{model,effort}`) to `feature-coverage.md` and `config-blueprint.md` | Real, documented, config-only feature absent from the "exhaustive" reference | Same source-of-truth copy from `docs/reference/feature-registry.md:135` | S | Both cron and webhook rows/blocks show per-job/per-endpoint `model`/`effort` | y |
| G1-4 | Add `@mono-agent/session-web` to `package-map.md`'s Observability Join table; add `--show-auth-url`, `--max-runs`, `MONO_AGENT_WEB_AUTH_TOKEN` to `feature-coverage.md`'s web-PWA row | Package-map's stated purpose is "which package owns what"; the auth-token gap is security-relevant for non-loopback web | One-line table additions | S | `session-web` appears in package-map; web PWA row lists the auth token requirement | n |
| G1-5 | Add `memory.backend`/`@mono-agent/memory-supermemory` to `feature-coverage.md`'s memory table and `package-map.md`'s Context And Skill Join table | The skill's own playbook 13 depends on a capability neither reference table documents | One-line table additions matching `docs/reference/feature-registry.md`'s Supermemory entry | S | Both tables mention the Supermemory backend and its package | n |
| G1-6 | Correct `config-blueprint.md:38`'s effort enum comment to the full `none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra` | Incomplete enum in the one file the skill tells the agent to trust over source | One-line comment edit | S | Comment lists all 8 values | n |

## 6 Skill-worthy flags

- **Composer-skill freshness needs a mechanical tripwire, not just goodwill.** Three of the six findings above are the same root cause: a feature shipped and got a `docs/reference/feature-registry.md` entry, but nobody back-ported it into `packages/agent-app/skills/mono-agent-composer/references/*.md`. Given `SKILL.md` explicitly instructs composing agents never to consult `feature-registry.md` or package source, this skill is the *single point of failure* for "does the framework support X" for every new user. Recommend a lightweight CI check (or a `docs-sync`-style skill extension) that fails when `docs/reference/feature-registry.md` gains a `config`-coverage row whose key isn't grep-able anywhere under `packages/agent-app/skills/mono-agent-composer/references/`.
- **`docs-sync` skill scope should explicitly include the composer skill's `references/*.md`.** Today `docs-sync` (per its description) syncs `docs/` and the website; this audit found the composer skill silently drifted out of that loop for at least 3 PRs' worth of shipped features (native-notify PR #98, per-trigger-model-effort PR, external-memory-backends PR #52). Suggest folding the composer skill's reference files into whatever "after any user-facing feature lands" doc-sync checklist already exists.

## 7 Coverage note

Every file in scope was read in full:

- `packages/agent-app/skills/mono-agent-composer/SKILL.md`
- `packages/agent-app/skills/mono-agent-composer/agents/openai.yaml`
- `packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md`
- `packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md`
- `packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md`
- `packages/agent-app/skills/mono-agent-composer/references/package-map.md`
- `packages/agent-app/skills/mono-agent-composer/references/playbooks.md`
- `packages/agent-app/skills/mono-agent-composer/references/validation.md`
- `packages/agent-app/resources/srt/package.json` (+ `package-lock.json` hash-verified against `sandbox-manager.ts`)
- `scripts/lib/build-provenance.mjs`
- `scripts/lib/memory-cleanup-calibration.mjs`
- `vitest.config.mjs` (root)
- `website/pnpm-workspace.yaml` (+ root `pnpm-workspace.yaml` for contrast)

Cross-referenced against: `docs/reference/feature-registry.md`, `docs/playbooks/*.md` (esp. `cron-digest-proactive-notify.md`, `webhook-automation-sync-async.md`), `docs/config/blueprint.md`, `docs/config/env-vars.md`, `PACKAGES.md`, `scripts/package-catalog.mjs`, `packages/cron-adapter/src/config.ts`, `packages/webhook-adapter/src/config.ts`, `packages/config/src/{types,enums,config}.ts`, `packages/agent-app/src/{cli.ts,sandbox-manager.ts,wizard/presets.ts}`, root `package.json` scripts, and `.github/workflows/*.yml` (for CI-wiring checks).
