---
title: "Setup security and managed runtime"
description: "Review guided setup trust boundaries, durable secret handling, readiness proofs, and managed processes."
sidebar:
  order: 7
---

This is the canonical reference for the low-level trust boundaries behind guided `mono-agent init`, durable secret setup, and the managed macOS background process. The [README Quickstart](https://github.com/robertsreberski/mono-agent#quickstart-an-agent-folder-from-one-config-file) intentionally keeps only the runnable path; this page records the security and operating-system details that path relies on.

## Operator endpoint exposure

The always-on web console deliberately remains a single-owner surface without application authentication and binds `0.0.0.0:5050` by default. That v1 tradeoff makes it usable across a trusted LAN or tailnet, but anyone who can reach the listener has owner-equivalent access to retained conversations and discovered agents. Use `mono-agent web start --loopback` when other devices must not reach it, and never publish the port directly to the internet. Host/Origin validation is a browser request-integrity guard, not an identity boundary; plain LAN HTTP is also unencrypted. Web Push adds an owner-private VAPID private key, browser endpoint/key material, and an outbox to the same resettable SQLite state. Those secrets never enter bootstrap, status, logs, or notification previews. Subscription registration is exact-origin, and outbound push endpoints are public-DNS/HTTPS validated and address-pinned to prevent the subscription API becoming an SSRF primitive. The [web console guide](/observability/web-console/#security-boundary-trusted-network-no-login) carries the operational details.

Webhook and OpenAI-compatible API listeners stay loopback-only unless explicit non-loopback opt-in is paired with a bearer key. A2A also defaults to loopback; public A2A deployments should require a bearer and terminate TLS at a reverse proxy. The repository-level [security policy](https://github.com/robertsreberski/mono-agent/blob/main/SECURITY.md) records vulnerability reporting and the manual local-secret cleanup checklist.

## Readiness is stronger than credential detection

The wizard keeps model discovery, credential detection, and verified readiness separate. After the explicit creation review, it makes one disposable no-tool call for every selected runtime route, in order, with a 90-second cloud or 240-second local deadline per route. A detected Codex or Claude login, or a credential in the Pi auth store, can skip a redundant login prompt but does not make a route ready. Provider failure, timeout, empty output, or any tool action fails that route.

Escape or Ctrl-C interrupts preflight safely. Recovery may resume only route proofs whose non-secret plan fingerprint still matches, restart all checks, edit choices, or cancel without writing. Authentication repair invalidates the previous route proofs because the credential bytes may have changed.

The wizard creates the config only after review and validates that exact snapshot. Any flag or non-TTY invocation is scaffold-only: it does not run the readiness proof, start a process, or label the result ready. Off macOS, guided setup preserves the files and hands control back to the operator for `validate`, `start --foreground`, and ordinary `tui`.

## Durable secret persistence

Selected secrets are entered through masked prompts and never appear in config JSON, `.env.example`, review output, logs, or file-change summaries. Existing non-empty `.env` assignments and comments are preserved. A selected secret found only in the current shell does not skip the durable prompt: a later background worker cannot inherit that shell, so the entered value must match every non-empty shell and dotenv copy before a missing dotenv value is persisted. Durable provider keys already present in `.env` receive the same preflight and hardening.

The readiness proof uses only inputs a later worker can reconstruct: durable `.env` values, the resolved Pi credential store, and a narrow operational host environment such as `PATH` and `HOME`. Shell-only `MONO_AGENT_*` config overrides cannot make setup pass and then disappear under background execution; persisted non-secret overrides are named and rejected so the reviewed JSON remains the configuration that is validated and started.

### POSIX file contract

Automatic persistence first canonicalizes the agent directory and requires it to be owned by the current user and not group- or world-writable. Existing `.env` and `.gitignore` paths must be current-user-owned, single-link regular files; neither may be a symlink, and `.env` must be untracked. Values must round-trip through the runtime dotenv parser. Exact root ignore rules cover `.env` and its transaction artifacts.

The update runs under an external owner-only lock. It writes an exclusive same-directory temporary file, applies owner-only mode `0600`, flushes the bytes, checks for concurrent changes, and uses pathname no-clobber promotion. Group/world write permission is removed from the `.gitignore` guard. A pathname competitor stays at the target instead of being overwritten.

The claimed inode is rechecked before installation and cleanup. If a write through an already-open descriptor is detected, the competing paths are reported and the candidate bytes remain at an owner-only recovery path. A non-cooperative POSIX writer that starts after the final check remains outside the guarantee.

Tracked, symlinked, hard-linked, foreign-owned, malformed, conflicting, empty, unrepresentable, stale-lock, or concurrently changed inputs fail closed. Windows receives manual instructions because owner-only permissions cannot be verified; automatic persistence does not replace an existing dotenv file there. Never copy `.env.example` over an already populated `.env`.

### Pi credential promotion

Pi OAuth and API-key setup stages a private `auth.json`, verifies that it is a JSON object containing a valid credential for the requested provider, and preserves sibling-provider entries before promotion. The canonical credential parent and every staged, recovery, or existing credential inode must pass the ownership, permission, and link-count checks.

Promotion uses an identity-bound owner-only lock and installs a `0600` file with exclusive no-clobber semantics on supported POSIX systems. An existing secure lock is removed automatically only when its record remains identity-stable and the recorded process is proven gone with `ESRCH`. Active, permission-denied (`EPERM`), malformed, or racing locks remain untouched. Automatic Pi credential persistence refuses Windows and auth paths inside Git worktrees.

## Managed macOS background runtime

### Exact executing closure

Guided macOS setup materializes the exact already-resolved CLI dependency closure into a private versioned runtime under `~/.mono-agent/runtimes/agent-app/`. The closure includes config-selected channel plugins and the optional Supermemory package. Copying it does not run npm, lifecycle scripts, or another dependency resolution, and it never daemonizes a disposable npm-cache path.

A complete source digest plus a relative path/type/mode/content-hash manifest is bound to the runtime marker and rechecked before reuse. Dependency or selected-plugin drift therefore prevents a stale managed closure from being treated as current.

### Publication barrier and active SRT closure

The controller keeps the current healthy LaunchAgent loaded while a replacement
closure is materialized. Before that work starts it publishes an owner-only,
per-label barrier under `~/.mono-agent/locks/`. A KeepAlive worker checks the
barrier before its lifetime lease or config load, waits while the controller's
PID/incarnation is live, and recovers stale ownership after a crash or PID
reuse. The controller releases the barrier only after the stopped-window plist
commit and immediately before bootstrap; pre-switch failures release it so the
old definition can continue. Successful release and stale-owner recovery remove
their lock/quarantine artifacts; malformed owner state is retained and fails
closed for operator inspection rather than being purged automatically.

Each new worker also requires the plist's path-free finalized-runtime proof. It
checks the canonical private layout, marker and manifest fingerprints, exact CLI
bytes, the sibling lightweight maintenance-entry digest, and whole-second launch
boundary before starting the app. The verified
install root is then an app-owned read-only SRT root. No config entry is needed,
and the implicit grant does not include `~/.mono-agent/runtimes/agent-app/`, a
version/ABI parent, or a historical closure.

### Clean environment and one lifetime lease

The LaunchAgent enters Node through `/usr/bin/env -i` and restores only the reviewed operational allowlist. Ambient launchd variables such as `NODE_OPTIONS` cannot run before worker sanitization, while the durable dotenv and operational inputs used during readiness remain reproducible at restart.

Every worker must acquire one owner-only canonical per-config lifetime lease. Canonicalization covers HOME variants, symlink-parent and filename-case aliases, and PID reuse. An existing launchd worker therefore cannot be duplicated by a second managed start or a manual foreground start of the same config.

### Recovery controller and bounded launchd logs

The controller installs a separate one-shot LaunchAgent beside each managed
worker. It retains `RunAtLoad` for login recovery and uses a deterministic
hourly `StartCalendarInterval`: the unsigned big-endian first four bytes of
SHA-256 of the canonical main label, modulo 60. The accepted once-per-login
fleet start remains and every helper retains recovery coverage; recurring recovery
is staggered. Before any PID query, lock, attestation, or dynamic controller import,
the lightweight entry waits SHA-256(canonical main label)[0..3] unsigned-big-endian
modulo 120 seconds. This 0–119-second deterministic dispersion shapes heavy work
without an account-wide admission lock or stale-owner authority. Worker-requested
wakes inherit the same maximum 119-second delay. It has no `KeepAlive`, sends
its own output to `/dev/null`, and shares the worker's per-config lifecycle lock.
Its private arguments retain the original controller CLI path, agent cwd,
absolute config path, optional dotenv path, and the worker's non-secret durable
`PATH`. Its plist targets the attested `dist/launchd-maintenance-entry.js`, not
the eager public CLI graph. The helper itself still executes with the closed `/usr/bin:/bin` path;
the worker path is rehydrated only for validation, snapshotting, and the worker
definition. After dispersion, the helper proves that its current PID is the
exact process launchd owns. It then acquires the per-agent lifecycle
lock without waiting, before attestation or importing the controller; a same-agent
loser exits before expensive work. The winner verifies the entry against the
shared runtime marker/proof and dynamically imports the heavy controller graph
while retaining that per-agent lock.

Each pass reconstructs the same durable dotenv-plus-operational environment,
and captures a fresh keyed snapshot. It strictly parses
the main definition launchd currently owns, verifies that definition's private
path-free launch proof, and compares its package version and CLI digest with the
original controller CLI as inert bytes. This healthy fast path does not traverse
the immutable closure or run the full structural validator. Only proven drift or
inactivity invokes full validation and managed-runtime installation/verification,
still under the per-agent lock. After installation and read-only ownership/snapshot
rechecks, recovery takes the per-account shared-chain lock without waiting only
around shared-directory and stopped-writer mutation. Automatic contention exits
successfully without mutation; healthy log-only maintenance takes the same shared
lock separately. Mutable checkout code is never executed. When
that source path has disappeared, an inactive or snapshot-drifted worker can be
recovered from the helper's already-private closure, but the pass does not claim
an upgrade or downgrade a healthy newer worker.

A stale snapshot, inactive PID, malformed loaded definition, invalid runtime
proof, or available newer/different source closure triggers reconciliation. The
old healthy worker remains loaded while the replacement closure is installed.
Consumers sharing that closure wait up to five minutes on the existing
PID/incarnation-aware install lock, so a slow first installation coalesces rather
than causing the other consumers to fail after 30 seconds. Under the shared
mutation lock, recovery then stops only the main job, repairs the shared chain,
commits refreshed worker and helper plists, and bootstraps the main job. It releases
the shared lock before the normal 60-second readiness proof. The currently
running helper is preserved. A failed install, commit, bootstrap, or readiness
check leaves both definitions and the helper available for the next scheduled
retry; it does not create a `KeepAlive` crash loop. Explicit `mono-agent stop`
still unloads the helper first and removes both definitions only after PID-death
proof, so the controller cannot resurrect an intentionally stopped service.
Recurring exit-0 refusal, runtime/config/snapshot/source drift, and shared-only
repair have a worst-case 60-minute healing latency between logins. Explicit
start/restart remain synchronous.

Once ready, the managed worker checks the fixed log policy immediately and every
five minutes: the active stdout/stderr file and each of three retained generations
may hold at most 5 MiB. This overlap-guarded path only reads the bounded metadata
inventory. A healthy below-threshold result does not reconstruct the environment,
validate config, capture a snapshot, or start another Node process. A concrete
safe per-agent oversized or permission-repairable log may ask launchd to wake
the authenticated controller, but not until the five-minute startup floor.
Shared-directory repair and pending lifecycle, journal, or preparation artifacts
never trigger a worker wake. The process-local monotonic cooldown is 5, 10, 20,
40, then 60 minutes; unloaded/running helpers are skipped and backed off. A
pathological worker crash loop can still request about once per five minutes per
agent because each replacement process starts a fresh floor (11 requests per
five minutes for an 11-agent pathological simultaneous loop).

Every operation that can repair or mutate the shared log directory chain—helper
maintenance, start/restart recovery, and stop—takes one per-account synthetic
PID/incarnation-aware lock in `~/.mono-agent/locks/`, after the per-agent
lifecycle lock. Helper/monitor paths defer immediately. Interactive
start/restart/stop wait at most 18 seconds at 400 ms intervals and then fail
visibly with holder PID, main label, incarnation, and acquisition time.
Unauthenticated, foreign-owned, malformed, or uncreatable lock roots fail closed.

A controller log-maintenance pass first verifies the owner-private main plist and
read-only log inventory; only when maintenance is necessary does
it atomically publish a bounded, owner-only, per-agent `stopping` intent, unload
the main job, and prove every PID observed through launchd bootout dead. Only
then does it atomically promote that intent to `stopped`. A pre-proof crash with
no remaining launchd PID fails closed instead of treating unload as death proof.
It then validates every
directory as a current-user-owned real directory and every log file as a
current-user-owned, non-symlinked, single-link regular file, installs fsynced
owner-only bounded tails by identity-checked atomic rename,
publishes a per-agent fsynced journal before the first target rename, and
requires the exact main-plist identity and content fingerprint to remain
unchanged, changes the intent to `restoring` before bootstrap invalidates the
old stop proof, and clears it only after the replacement worker is live.
Deterministic stages and payload hashes make a partial commit retry the same
transaction exactly once; only a durable `stopped` intent authorizes recovered
rotation, and a missing lifecycle intent never authorizes resurrection.

Start/restart unload the scheduler before the worker and run the same maintenance
inside the stopped window before loading scheduler then worker. Stop unloads the
scheduler first and removes both definitions only after both jobs and observed
PIDs are gone. An unsafe path, stop failure, write/fsync/rename failure, or plist
race returns an error; after the worker has stopped, failure leaves it stopped
instead of claiming success or entering a restart loop. `validate` and `doctor`
only read path metadata and report exact sizes for safely inspected files;
unsafe or unreadable byte inventory is unavailable. They never repair
permissions or rotate.
The monitor writes only an owner-private, bounded informational snapshot for
doctor (last inspection, cumulative wake count, last outcome, cooldown
deadline); monotonic in-process state remains the cooldown authority. Existing
loaded helpers keep their old schedule until each agent is explicitly restarted:
`launchctl print` is authoritative, and no fleet restart is implied by upgrade.

The managed web console uses a parallel, deliberately isolated controller:
`com.mono-agent-web-maintenance`. Its one-shot plist has `RunAtLoad`, a stable
hourly minute, deterministic 0–119-second pre-import dispersion, no `KeepAlive`,
`/dev/null` output, and only the fixed marker plus system `PATH`. It runs from
the same attested managed-runtime closure as the web worker. Before importing
the heavy controller it proves its exact launchd PID and cached private argv;
the controller then verifies the on-disk helper and the main web plist's
composite `dev:ino:size:sha256` identity again after taking the web lifecycle
lock. The main plist is always written first and the helper is regenerated from
that fresh identity after every publication or restoration write. A partial or
stale pair is never bootstrapped.

Web log mutation uses only the web lifecycle lock under
`~/.mono-agent/web/locks/`. The web directory is outside the shared configured-
agent log chain, so the helper never acquires or writes ownership into the
agents' shared log lock. The worker is wake-only; only the helper may rotate.
The same durable `stopping` → `stopped` → `restoring` proof guards the fixed
5 MiB active-plus-three-generations policy. Exact pre-helper
`web.{out,err}.log.{rollover,retiring}-<uuid>` leftovers are removed only after
stopped-writer proof and only when they remain current-user-owned, regular, and
single-link; unsafe or merely similar files are preserved and reported.

Start and restart stop helper before worker, perform any proven stopped-window
maintenance, publish the paired definitions, then bootstrap helper before
worker. Stop proves both PIDs dead before removing both plists. Reset takes the
same lifecycle lock and requires both jobs stopped and both definitions absent.
The helper never resurrects a console without durable restoration authority.
Because an authorized rotation restarts the web service, in-flight turns and
SSE streams can be interrupted; this availability cost is why safe oversize
logs waiting for the next hourly pass are reported as `due` rather than rotated
more eagerly. Missing or stale authority, unsafe inventory, refused legacy
files, and abandoned recovery remain durable nonzero `web status` problems.
Proven stopped/restoring recovery uses `mono-agent web restart`. An unproven
`stopping` intent or a fingerprint tied to an older main plist cannot safely be
promoted by restart; status instead directs `mono-agent web stop` followed by
`mono-agent web start`, and stop clears the stale intent only after both jobs
are proven down.

### Frozen inputs and startup proof

Before app or channel loading, managed startup freezes the attested config, Identity, optional Soul, and external MCP authority file into private read-only runtime inputs. Trace and status records still identify the canonical operator-facing config path.

Managed readiness waits up to 60 seconds for the worker's durable `metadata.lifecycle.startupCompleted: true` proof. The worker publishes it only after channels, memory rituals, and the final memory-health lifecycle refresh complete. Later trace publications retain the proof while `metadata.reason` records their latest diagnostic reason, so a periodic health refresh cannot close the attach window. Readiness also requires the trace PID to be alive and launchd-owned; the committed config, `.env`, Identity, Soul, MCP authority, and operational-environment fingerprints to agree; configured channels and current memory health not to have failed; and, for configuration, the TUI endpoint to be reachable. Workers from a release that predates the durable proof must restart once before SELF-CONFIG can attach.

`mono-agent status` applies the same process-ownership direction: a cached trace
is running only when its PID is alive and equals launchd's current PID. Otherwise
the command removes the stale PID and transport facts, reports stopped health,
and rewrites cached `running` channels to `stopped: instance is not running`.
JSON status returns `ok: false` and exit 1 for that inactive state.

Only after those checks does guided init open `mono-agent tui --configure` against that process. A readiness deadline or trace/TUI-probe error preserves the committed files and skips configuration chat, then uses the same ownership-proven stop path to unload the worker and scheduled-maintenance jobs and remove both definitions. If launchd or PID checks cannot prove the stop, the command fails explicitly that a process may still be running and prints exact `start`, `status`, and `logs --follow` recovery commands.

### Keyed background snapshot commitments

Exact background file bytes are committed with a per-config 256-bit HMAC key stored under owner-only `~/.mono-agent/background-snapshot-keys/`. The controller creates the key and managed workers load it. Process arguments and trace metadata contain neither the plaintext files nor an offline-testable unkeyed credential digest.

## Persistent self-configuration and rollback

The first TUI session after guided macOS setup is visibly marked `[SELF-CONFIG]`, not ordinary chat. Its opening guide maps all capability areas once and helps the operator shape a workflow one focused question at a time. It tells the operator not to enter secrets and requires a host-rendered approval before any proposed change can be applied. Ordinary action tools and configured MCP servers are replaced with the narrow configuration capability for every non-command turn in that session.

A proposal-free turn, rejection, successful approval, `done`, `no changes`, or recovered rollback rotates the opaque proposal capability and continues the same configuration conversation. Approval commits the files, restarts the agent, waits for its new ready source, and only then swaps the TUI endpoint and supplies a fixed host-outcome summary to the next turn. If the new configuration cannot start, the host restores the previous files and attempts to restart the prior agent. Text submitted while settlement is in progress is restored to the editor and never sent to ordinary chat or stale local state. If neither the new start nor recovery can prove a live endpoint, the marker remains visible, the endpoint disconnects, and manual recovery is required. Only `/quit`, `/exit`, or double `ctrl+c` exits self-configuration; quitting does not stop the background agent.

## Related references

| Topic | Canonical page |
| --- | --- |
| Install choices and source builds | [Install & Prerequisites](/getting-started/install/) |
| Complete first-agent workflow | [Your First Agent](/getting-started/quickstart/) |
| Dotenv precedence and secret fields | [Environment Variables](/config/env-vars/) |
| Agent-folder ownership and generated paths | [Folder Layout](/config/folder-layout/) |
| Exact command, readiness, and recovery behavior | [CLI Reference](/observability/cli-reference/) |
| Self-configuration authority | [TUI](/observability/tui/) |
| Feature-level coverage contracts | [Feature Registry](/reference/feature-registry/) |
