# F1-live-personal-agent — Live instance: personal-agent (flagship, deep)

## 1 Verdict & maturity grade

**Overall maturity: B+.** This is a genuinely mature, actively-dogfooded instance: memory is current and
well-formed (graph.jsonl and daily notes updated same-day, zero capture backlog), the skill/cron/webhook
registry is internally consistent (every skill in `skills/` is enumerated 1:1 in `AGENTS.md`'s single-owner
table), PARA is used as designed (`inbox/` empty, dashboards current), git history shows daily disciplined
commits, and several of the instance's own scripts (`bin/lib/heartbeat-state.mjs`,
`bin/lib/focus-scan-lock.mjs`, `bin/lib/health-webhook.mjs`, `bin/lib/portal-auth.mjs`) are careful,
security-conscious, atomic-write, TOCTOU-aware code that would pass a strict review on their own. What
holds it back from an A: real, verifiable operational rough edges have accumulated — an unrotated 1.23GB
error log, a version-provenance split between the pinned production runtime and the admin/watchdog
tooling, a chronic (thousands of restarts) Telegram polling instability that is invisible to the operator,
a documented quiet-hours promise that one delivery path doesn't keep, and a broken fallback path in
voice-capture. None of these caused data loss or a fake-success reading in what I could observe — the
system tends to fail loud/self-heal rather than fake it — but they are real, dated, and reproducible.

**Framework-fit grade: B.** The config-first primitives (cron/webhook as prompt files, allow-all tools,
`memory.mode: bujo`, native `notify: true` delivery, `mcpRequestContextServers`) are exactly what let one
operator run a 24-skill, multi-channel, multi-account assistant from one config folder — the premise
holds up well here. Where the instance fights the framework: (a) nothing in `mono-agent`/`agent-app`
caps or rotates launchd `StandardOutPath`/`StandardErrorPath`, so the operator had to invent an ad hoc
`.1` rotation; (b) the framework's pinned-runtime-snapshot model (`~/.mono-agent/runtimes/...`) isn't
consistently used by the instance's own tooling, so its safety benefit is only partial; (c) the
`mcpRequestContextServers` request-context feature is producing a hard fatal in a real, documented
fallback flow; (d) the native `notify`/quiet-hours contract only covers one of the instance's two
Telegram-delivery code paths, and nothing in the framework signals that gap to an author writing a
second path.

## 2 Findings

**F1 (P1) — 1.23GB of launchd stderr accumulated unrotated, mixing three code-provenance eras.**
`/Users/robertsreberski/.mono-agent/logs/com.mono-agent.personal-agent-059657c8.err.log.1` is
1,233,420,489 bytes. Its content spans `scheduledAt` timestamps from `2026-06-15` to `2026-07-06` (three
weeks) with zero rotation, contains 4,254 Telegram `getUpdates` timeout/restart cycles and 61
`EADDRINUSE: address already in use 127.0.0.1:4400` startup-crash entries, and mixes stack traces from
three different execution contexts (direct `Personal_Repositories/mono-agent` source, the
`.mono-agent/runtimes/agent-app/0.9.1` pinned snapshot). The still-growing current file (`err.log`, no
suffix, 656KB/5,969 lines as of the audit) already contains 276 more `getUpdates` restart cycles and old
`focus-scan-hourly` job-id errors from `2026-07-09`, confirming it isn't truncated on restart either.
Nothing in `bin/install-launchd` (read in full) or the plist (`ThrottleInterval`/`KeepAlive` only) caps or
rotates these paths — the only size management observed is disabled `chmod 600` tightening, not rotation.
Contradicts "honest ops" (silent unbounded growth) and legibility (cross-version log makes postmortems
hard).

**F2 (P1) — Admin/watchdog tooling is not pinned to the same runtime as the production service.**
The live launchd plist (`~/Library/LaunchAgents/com.mono-agent.personal-agent-059657c8.plist`) runs a
version-pinned, immutable snapshot:
`~/.mono-agent/runtimes/agent-app/0.11.2/darwin-arm64-abi-137/.../node_modules/@mono-agent/agent-app/dist/cli.js`
(confirmed `package.json` version `0.11.2`, matching framework repo HEAD `5f27a0ec`). But
`bin/mono-agent:7`, `bin/agent-watchdog:25` (`const CLI = '/Users/robertsreberski/Personal_Repositories/mono-agent/packages/agent-app/dist/cli.js';`),
and `bin/session-web:5` all hardcode the **mutable monorepo checkout's own dist**, not the pinned
snapshot. At audit time both happen to be `0.11.2` (no live drift), but nothing enforces that — the
monorepo is the same actively-developed repo this very audit runs against. A routine `pnpm build` on a
WIP branch there would silently change what `bin/agent-watchdog`'s `mono-agent memory audit --strict`
health check (called every ~15 min, `agent-watchdog:122-133`) executes against, while the actual serving
process keeps running the older pinned snapshot — a false-green or false-red health read decoupled from
what's actually live. This is exactly the "snapshot-vs-dist provenance" split the recon hints flagged.

**F3 (P2) — Telegram `getUpdates` instability is chronic and has no operator-visible signal.**
Across the sampled log window (`.err.log.1` + current `err.log`), roughly 4,530 "Telegram polling stopped
with an error... Request to 'getUpdates' timed out after 50 seconds" → 500ms-backoff-restart cycles were
logged over about 5 weeks (~130/day). The channel self-heals every time (`Telegram channel degraded;
transport is recovering.` immediately follows), so no confirmed message loss, but `bin/agent-watchdog`
(read in full) only checks process-liveness via `launchctl list` (`agent-watchdog:107-115`) — it has no
condition on this internal churn rate, so a chronic degradation of the instance's single interactive
channel is only discoverable by grepping multi-hundred-MB log files, not by anything Robert or the
watchdog surfaces.

**F4 (P2) — Documented quiet-hours "silent delivery" promise is not implemented on the heartbeat delivery
path.** `skills/telegram-notifications/SKILL.md:22` states: "During configured quiet hours (23:00–07:00
Europe/Rome) proactive deliveries still arrive but land **silently** (no push sound)." That is true for
native-notify (`notify: true`) cron/webhook jobs. But `cron/heartbeat.md` and `cron/heartbeat-final.md`
both set `notify: false` and instead call `./bin/heartbeat commit` → `sendNativeTelegramCard`
(`bin/lib/telegram-alert.mjs`, read in full) — a raw `fetch` to `api.telegram.org` that never sets
`disable_notification` and contains no time-of-day check anywhere in the file. This is currently masked
only because the heartbeat cron's own schedule (`07:15–22:00`) doesn't overlap the quiet window by
coincidence of manual scheduling, but the README-documented callback re-delivery ("`Show details`,
`Draft reply`, and `Review draft` callbacks can reopen bounded context for... up to 30 days") has zero
quiet-hours protection: a tap on an old card at 02:00 fires a normal audible push. This is a verifiable
gap between a written promise and the code, in the exact attention-protection area the premise/IDENTITY.md
calls out ("Protect Robert's attention and energy").

**F5 (P2) — The voice-capture MCP fallback is currently broken.** `skills/voice-capture/SKILL.md` documents
falling back to the `transcribe` MCP tool (`.mcp.json`, `mcpRequestContextServers: ["transcribe"]` in
`mono-agent.config.json`) when the inline WhisperKit transcript is missing (e.g., recordings over the
~2-min budget). The current `err.log` shows 34 occurrences of `transcribe-mcp: fatal: missing trusted
producing conversation context` and 24 occurrences of `Resilient stream received runtime warning.
{"warningKind":"mcp_init_failed","message":"MCP error -32000: Connection closed"}` — zero occurrences of
either in the prior 3-week `.err.log.1`, so this looks like a recent regression tied to the
`mcpRequestContextServers` request-context feature. When it fires, the one safety net for long voice notes
is unavailable.

**F6 (P2) — Cron overlap/skip rate was high before the 2026-07-10 cadence change, and is invisible outside
raw logs.** Cron-finish/skip tallies from the current log: `focus-scan-hourly` finished 59 / skipped 18
(≈23%), `heartbeat` finished 62 / skipped 7, `evening-checkin` finished 10 / skipped 5 (33%),
`morning-briefing` finished 12 / skipped 4. Since the 2026-07-10 cadence change to 4×/day, the renamed
`focus-scan` job shows a much healthier 22 finished / 1 skipped. The historical rate is a real signal that
the run-overlap-skip semantics (`Cron job skipped because a prior run is still active.`) were previously
masking a capacity problem, and — like F3 — nothing surfaces the skip *rate* itself to the operator; it's
only visible via `grep`.

**F7 (P3) — OpenAI-compatible API and Session Web are LAN-wide (`0.0.0.0`), not tailnet-restricted like the
webhook.** Confirmed via `lsof`: `node 12739 ... TCP *:4312 (LISTEN)` (config: `openaiApi.host: "0.0.0.0"`,
`allowNonLoopback: true`) and `bin/session-web:10-12` passes `--host 0.0.0.0 --allow-non-loopback`. Both
are bearer-token-authenticated (`MONO_AGENT_OPENAI_API_KEY` / `MONO_AGENT_WEB_AUTH_TOKEN` present in
`.env`), and the webhook channel deliberately binds only the Tailscale IP
(`100.64.103.59:4313`, `AGENTS.md:114-116`, explicitly reasoned as "Tailscale provides device auth, so
there is no app-level secret"). The other two surfaces don't get that same treatment even though they sit
in front of a `sandbox.mode: "off"`, `allowedTools: ["*"]` profile — a single leaked/guessed token is a
strictly bigger blast radius here than on the narrow-prompt webhook. This is a documented, conscious
choice (README "Conscious decisions" section), not a silent bug, so I score it P3, but the asymmetry with
the webhook's own stated rationale is worth closing.

**F8 (P3) — Dead retired-heartbeat surface partially still imported by live code.**
`bin/lib/heartbeat-prefilter.mjs` (read in full) is now mostly a compatibility shim:
`runHeartbeatPrefilter()` deliberately throws ("heartbeat prefilter is retired..."), `shouldRunHeartbeat`
is unused outside the retired `bin/heartbeat-prefilter` binary and tests, but `readHeartbeatState` (an
aliasing wrapper around `heartbeat-state.mjs`'s real implementation) is re-exported from this file and is
imported live by `bin/agent-watchdog:10`. A reader of `agent-watchdog`'s imports would reasonably assume
the prefilter is still wired in; it isn't. `install-launchd` (read in full) does actively `bootout`+`rm`
the retired `com.user.personal-agent-heartbeat.plist` from `~/Library/LaunchAgents` on every run (good
hygiene, confirmed absent from the live LaunchAgents directory) — but the repo's own
`launchd/com.user.personal-agent-heartbeat.plist` source file (pointing at the retired
`bin/heartbeat-prefilter`) is never staged by the installer and has no remaining purpose.

## 3 Dead code

- **`bin/heartbeat-prefilter`** (binary) — not installed by any live LaunchAgent (confirmed absent from
  `~/Library/LaunchAgents`); referenced only by its own lib and by `tests/heartbeat.test.mjs`. Disposition:
  delete, plus the now-pointless unit tests of `shouldRunHeartbeat`.
- **`bin/lib/heartbeat-prefilter.mjs`: `runHeartbeatPrefilter`, `shouldRunHeartbeat`** — dead (see F8);
  `readHeartbeatState`/`writeHeartbeatState`/`defaultHeartbeatState`/`HEARTBEAT_MAX_FUTURE_SKEW_MS` are
  live re-exports and must be kept (or imported directly from `heartbeat-state.mjs` instead). Proof:
  `grep -rl heartbeat-prefilter` outside this file and `bin/heartbeat-prefilter` hits only
  `bin/agent-watchdog` (one live import) and two test files.
- **`launchd/com.user.personal-agent-heartbeat.plist`** — dead repo artifact; the installer only removes it
  by filename from `RETIRED_PLISTS`, never stages its content. Disposition: delete the file from the repo.
- **`~/personal-agent/--limit/`** — a structurally valid but empty (0 rows in `messages`) wacli SQLite
  store created at the agent's own working directory (`cwd: agentDir` in
  `bin/lib/focus-scan-snapshot.mjs:367`), evidently from a past `wacli ... --limit N` CLI-argument mishap.
  Already gitignored (`--limit/` in `.gitignore`) but never deleted; its `.db-shm` file is still touched as
  recently as the day of this audit, so something continues to open it. The real store
  (`~/.wacli/wacli.db`, 13MB, actively synced) is unaffected. Instance-level cleanup — `wacli` is a
  third-party tool, not framework code.
- **`~/.pi/personal-agent/settings.json`: `defaultModel: "qwen3.6"`, `defaultProvider: "ollama"`** —
  vestigial `pi` CLI init defaults; the actual model routing is entirely governed by
  `mono-agent.config.json`'s `runtime.model`/`fallbackModels`. Harmless but stale; safe to leave or reset.
- **`.mono-agent/great-triage-2026-07-11.applied.log` / `.before.tsv`** — one-off bulk-cleanup operation
  logs sitting loose at the `.mono-agent/` root rather than under a dated subfolder. Harmless, but clutter;
  candidate for archiving once the operation is confirmed durable.

## 4 Deprecation & legacy

- **`webhook/health-metrics.md`, `webhook/heartbeat-evaluate.md`** (`enabled: false`) — **load-bearing, not
  removable.** Both are deliberate "path reservations" documented in `AGENTS.md:117-125`: keeping them
  disabled prevents the model-backed webhook adapter from ever claiming those paths and creating a second,
  conflicting evaluator. Confirmed by direct read of both files — clear rationale, correctly wired as
  `enabled: false`.
- **`.mono-agent/heartbeat/state.v2-pre-cutover.json`** — **load-bearing, keep.** Explicit, documented
  rollback artifact per README's "Heartbeat judgment is model-first" section ("rollback requires restoring
  the owner-only pre-cutover v2 backup"). Do not prune without a policy decision.
- **`.mono-agent/memory/legacy/`** (pre-v3-rebuild daily notes, `2026-06-21`…`2026-07-08`) — kept as the
  historical record the 2026-07-14 memory rebuild (`sourceFingerprint`/`policyVersion:
  mono-agent-memory-rebuild-v1` in `.mono-agent/memory/.index/manifest.json`) was derived from
  (`parsedSourceItems: 2422`, with documented `skippedRawRecords`/`skippedUnstructuredRecords`/etc.
  counts). Load-bearing as an audit trail for that rebuild; safe to prune only under an explicit retention
  policy, not casually.
- **`bin/heartbeat-prefilter` family** — see Dead code above; this is the one genuinely removable legacy
  surface in scope, already three-quarters retired by the operator with an active regression test
  (`tests/docs-contract.test.mjs:93,140`) guarding against its resurrection — good practice, just an
  incomplete cleanup.
- **`.mono-agent/.memory-forget-backup-01e5da2d0738871a9bf58a6c/`** (40MB) and
  **`.mono-agent/operator/forget-2026-07-14/`** — two separate `memory forget`-operation backup snapshots
  already exist with no visible retention/pruning policy alongside them (the artifact-retention scheduler
  in the startup banner governs `.mono-agent/artifacts`, not these). Not yet a problem, but will
  accumulate unbounded across every future `memory forget` call if nothing prunes them.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| F1-1 | Cap/rotate the launchd stdout+stderr logs | 1.23GB unrotated log; "honest ops" / disk health | Add a size-capped rotate step (e.g. truncate/archive past 50–100MB) to `bin/install-launchd` or a small periodic helper wired into `bin/agent-watchdog` | S | `du -h` on both log files stays under the cap after 2 weeks; old `.1` archived or deleted | n |
| F1-2 | Point `bin/mono-agent`, `bin/agent-watchdog`, `bin/session-web` at the pinned runtime snapshot instead of the live monorepo checkout | Watchdog health-checks and admin CLI must reflect what's actually serving traffic; correctness/false-health-signal risk | Resolve the CLI path the same way the launchd plist does (`~/.mono-agent/runtimes/agent-app/<pinned-version>/...`), or read the pinned version from the plist/config instead of hardcoding `Personal_Repositories/mono-agent` | M | `bin/mono-agent --version` matches the live plist's pinned snapshot version even after a monorepo-only rebuild that doesn't touch the pinned snapshot | n |
| F1-3 | Add a Telegram-polling-instability signal to the watchdog | ~4,500 chronic `getUpdates` restart cycles are invisible to Robert; "honest ops" | Extend `bin/lib/watchdog.mjs` to tally recent "Telegram channel degraded" events (e.g. per rolling hour) and alert past a threshold | S | A synthetic high-rate log sample trips the new watchdog condition in a test | n |
| F1-4 | Make `sendNativeTelegramCard`/`sendNativeTelegramNotifications` honor quiet hours | Documented "lands silently during quiet hours" promise doesn't hold for the heartbeat/callback delivery path; attention-protection premise clause | Add a Europe/Rome time check in `bin/lib/telegram-alert.mjs` that sets `disable_notification: true` (and/or defers) during 23:00–07:00 | S | Unit test: calling `sendNativeTelegramCard` at a mocked 02:00 Europe/Rome time asserts `disable_notification=true` in the POST body | n |
| F1-5 | Root-cause the `transcribe-mcp: fatal: missing trusted producing conversation context` fatal | Voice-capture's documented long-voice-note fallback is currently broken; correctness | Reproduce with a >2-min voice note; trace whether `mcpRequestContextServers` context propagation reaches this stdio MCP server on Telegram-originated turns | M | A manually-sent >2-min test voice note transcribes via the MCP fallback with 0 fatal errors logged | n (flag to the MCP/runtime framework territory if root-caused there) |
| F1-6 | Bind `openaiApi` and Session Web to the Tailscale IP instead of `0.0.0.0` | Matches the webhook's own stated rationale; shrinks the blast radius of a single leaked bearer token against an unsandboxed, allow-all-tools profile | Change `openaiApi.host` in `mono-agent.config.json` and `bin/session-web`'s `--host` to `100.64.103.59` | S | `lsof -iTCP -sTCP:LISTEN` no longer shows `*:4312`/`*:4599`, only the Tailscale IP | n |
| F1-7 | Finish the heartbeat-prefilter retirement | Legibility: a "retired" module is still a live import path; "a competent stranger must understand the core" | Move the one live export (`readHeartbeatState`) to be imported directly from `heartbeat-state.mjs`; delete `bin/heartbeat-prefilter`, the dead exports in `heartbeat-prefilter.mjs`, `launchd/com.user.personal-agent-heartbeat.plist`, and the now-pointless prefilter unit tests | S | `grep -r heartbeat-prefilter` returns no matches repo-wide; `docs-contract.test.mjs` updated accordingly | n |
| F1-8 | Clean up the stray `--limit/` wacli store | Disk/legibility cruft; possible sign of a recurring CLI-invocation slip | Find what still touches `--limit/wacli.db-shm` (e.g. `lsof`/`fs_usage` during a scan), fix the invocation if it's agent-triggered, then delete the directory | S | Directory does not reappear after 5 subsequent focus-scan/heartbeat cycles | n |
| F1-9 | Add a bounded retention rule for `memory forget` backup snapshots | Two forget-operation backups already exist (40MB+) with no pruning; unbounded growth risk | Extend the existing artifact-retention scheduler (or `agent-maintenance` skill) to also cap/expire `.mono-agent/.memory-forget-backup-*` and `.mono-agent/operator/forget-*` | S | Disk usage under `.mono-agent/` stops growing unbounded from forget backups after the policy ships | n |
| F1-10 | Reduce entity-normalization noise in memory | Premise: "clean memory (+ a way to preview it)"; `index.md`'s Entities section shows the same referent split across near-duplicate typed rows and many ultra-ephemeral time/date entities | Add a lightweight entity-type reconciliation pass in the bujo capture pipeline, or filter low-value entity types out of the top-level index preview | M | A sample of 50 `index.md` entity rows shows ≤1 row per distinct real-world referent | n |

## 6 Skill-worthy flags

- **`fleet-deploy`**: amend to (a) check/cap launchd `StandardOutPath`/`StandardErrorPath` sizes as part of
  every deploy, since an unrotated log silently grew to 1.23GB here before anyone noticed; (b) verify that
  every CLI wrapper script an instance ships (`bin/mono-agent`, `bin/agent-watchdog`, `bin/session-web` or
  equivalents) resolves the **pinned runtime snapshot** the live plist uses, not a mutable monorepo
  checkout path — this is a pattern risk for every fleet instance, not just personal-agent, since the same
  monorepo is under continuous active development on this very machine.
- **`live-smoke`**: add a post-deploy check for chronic channel-restart churn (e.g. grep the last hour of
  logs for repeated "channel degraded"/"scheduling restart" pairs above a threshold) — this instance
  accumulated ~4,500 such cycles over 5 weeks with nothing in the standard smoke/verify flow ever
  surfacing it.
- No new skill needed beyond amendments to the two above; the underlying gotchas (unrotated logs,
  snapshot-vs-checkout drift, quiet-hours parity across delivery paths) are concrete and specific enough to
  fold into existing skill docs rather than invent a new one.

## 7 Coverage note

Read in full: `mono-agent.config.json`, `IDENTITY.md`, `AGENTS.md`, `README.md`, all 7 `cron/*.md`
(`evening-wrap.md`, `focus-scan.md`, `heartbeat-final.md`, `heartbeat.md`, `morning-briefing.md`,
`topic-watch.md`, `weekly-review.md`), all 3 `webhook/*.md` (`health-metrics.md`,
`heartbeat-evaluate.md`, `therapy-transcript.md`), all 24 `skills/*/SKILL.md` headers/purpose sections
(`agent-browser`, `agent-maintenance`, `apple-reminders`, `automattic-context`, `drafts-app`,
`email-triage`, `finance-ai`, `focus-scan`, `google-workspace`, `heartbeat`, `idea-capture`,
`knowledge-base`, `nintendo-playtime`, `playbooks`, `proactiveness`, `reply-drafting`, `spend-analysis`,
`spotify`, `telegram-notifications`, `todoist`, `topic-watch`, `voice-capture`, `weekly-review`,
`whatsapp` — note: 24 actual skill directories, not the 27 in the recon hint; all 24 match `AGENTS.md`'s
registry table 1:1), `.mcp.json`, `.gitignore`, `.env`/`.env.example` (variable names only), `projects/_index.md`,
`launchd/com.user.personal-agent-heartbeat.plist`,
`~/Library/LaunchAgents/com.mono-agent.personal-agent-059657c8.plist`, `bin/agent-watchdog`,
`bin/heartbeat`, `bin/heartbeat-prefilter`, `bin/install-launchd`, `bin/mono-agent`, `bin/session-web`,
`bin/lib/heartbeat-prefilter.mjs`, `bin/lib/heartbeat-state.mjs`, `bin/lib/focus-scan-lock.mjs`,
`bin/lib/telegram-alert.mjs`, `bin/lib/health-webhook.mjs`, `bin/lib/portal-auth.mjs`,
`.mono-agent/memory/index.md`, `.mono-agent/memory/daily/2026-07-15.md`,
`.mono-agent/memory/.index/manifest.json`, `.mono-agent/memory/.index/runtime.json`,
`.mono-agent/outbound-audit.jsonl`.

Read partially / sampled (structure and risk-weighted excerpts, not full line-by-line): `bin/lib/watchdog.mjs`
(header + functions referenced by `agent-watchdog`), `bin/lib/gws-credential-transaction.mjs` (header +
permission/ownership logic), `bin/lib/focus-scan-snapshot.mjs` (WhatsApp/Gmail source-fetch sections),
`.mono-agent/memory/graph.jsonl` (14,060 lines — tail sample + line count, not read in full),
`~/.mono-agent/logs/com.mono-agent.personal-agent-059657c8.{out,err}.log` and `.err.log.1` (grep/head/tail
sampling given multi-hundred-MB to 1.23GB sizes; not read line-by-line), `~/.pi/personal-agent/settings.json`
and `models.json` (excerpted), `tests/*.mjs` (headers/`describe` counts only, per the audit method's
skim-tests instruction: `docs-contract.test.mjs`, `focus-scan-local-helpers.test.mjs`,
`focus-scan-remote-helpers.test.mjs`, `focus-scan-snapshot.test.mjs`, `gws-wrapper.test.mjs`,
`health-webhook.test.mjs`, `heartbeat.test.mjs`, `personal-tools.test.mjs`, `security-tools.test.mjs`,
`watchdog.test.mjs`).

Not opened in this pass (directory-listed/grepped only, given the scope's overall size and time budget):
remaining `bin/*` top-level scripts (`assistant-calendar-upsert`, `drafts-capture`, `drafts-read`,
`focus-dashboard-regen`, `focus-scan-maintenance`, `focus-scan-snapshot`, `gws-a8c`, `gws-paola`,
`gws-personal`, `gws-wrapper.mjs`, `outbound-audit`, `portal-auth-seed`, `todoist-upsert`); the remaining
`bin/lib/*.mjs` files not shown above in full (`assistant-calendar-upsert.mjs`,
`focus-dashboard-regen.mjs`, `focus-scan-maintenance.mjs`, `gws-wrapper.mjs`, `outbound-audit.mjs`,
`private-json-spec.mjs`, `todoist-upsert.mjs`); `skills/*/references/` and `skills/*/scripts/` payloads
(e.g. `nintendo-playtime/playtime.py`, `nintendo-playtime/cache.py`, `spotify/scripts/*`,
`focus-scan/scripts/*`); full content of `areas/**/*.md`, `projects/**/*.md`, `resources/*.md` (grepped for
secrets only, not read for content quality); `.mono-agent/memory/legacy/*.md`,
`.mono-agent/hygiene/filter-candidates.jsonl`, `.mono-agent/portal-checks/*.json`,
`.mono-agent/topic-watch/*.jsonl` bodies (listed/sampled, not fully read). Directory structure, sizes,
mtimes, `git log`/`git status`, `launchctl list`, and `lsof -iTCP -sTCP:LISTEN` were used throughout as
read-only verification (no `sqlite3` writes; all DB reads used `mode=ro` file URIs or plain read-only
`select`/`.tables` queries).