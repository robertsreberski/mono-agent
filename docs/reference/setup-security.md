---
title: "Setup security and managed runtime"
sidebar:
  order: 6
---

# Setup security and managed runtime

This is the canonical reference for the low-level trust boundaries behind guided `mono-agent init`, durable secret setup, and the managed macOS background process. The [README Quickstart](https://github.com/robertsreberski/mono-agent#quickstart-an-agent-folder-from-one-config-file) intentionally keeps only the runnable path; this page records the security and operating-system details that path relies on.

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

### Clean environment and one lifetime lease

The LaunchAgent enters Node through `/usr/bin/env -i` and restores only the reviewed operational allowlist. Ambient launchd variables such as `NODE_OPTIONS` cannot run before worker sanitization, while the durable dotenv and operational inputs used during readiness remain reproducible at restart.

Every worker must acquire one owner-only canonical per-config lifetime lease. Canonicalization covers HOME variants, symlink-parent and filename-case aliases, and PID reuse. An existing launchd worker therefore cannot be duplicated by a second managed start or a manual foreground start of the same config.

### Bounded launchd logs

The controller installs a separate scheduled one-shot LaunchAgent beside each
managed worker. It has no `KeepAlive`, sends its own output to `/dev/null`, and
checks a fixed policy every five minutes: the active stdout/stderr file and each
of three retained generations may hold at most 5 MiB. It shares the worker's
per-config lifecycle lock. A maintenance pass first verifies the owner-private
main plist and read-only log inventory; only when maintenance is necessary does
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

### Frozen inputs and startup proof

Before app or channel loading, managed startup freezes the attested config, Identity, optional Soul, and external MCP authority file into private read-only runtime inputs. Trace and status records still identify the canonical operator-facing config path.

Managed readiness waits up to 60 seconds for the worker's durable `metadata.lifecycle.startupCompleted: true` proof. The worker publishes it only after channels, memory rituals, and the final memory-health lifecycle refresh complete. Later trace publications retain the proof while `metadata.reason` records their latest diagnostic reason, so a periodic health refresh cannot close the attach window. Readiness also requires the trace PID to be alive and launchd-owned; the committed config, `.env`, Identity, Soul, MCP authority, and operational-environment fingerprints to agree; configured channels and current memory health not to have failed; and, for configuration, the TUI endpoint to be reachable. Workers from a release that predates the durable proof must restart once before SELF-CONFIG can attach.

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
