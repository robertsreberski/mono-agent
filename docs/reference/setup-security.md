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

### Frozen inputs and startup proof

Before app or channel loading, managed startup freezes the attested config, Identity, optional Soul, and external MCP authority file into private read-only runtime inputs. Trace and status records still identify the canonical operator-facing config path.

`startup-complete` is accepted only when the trace PID is alive and launchd-owned; the committed config, `.env`, Identity, Soul, MCP authority, and operational-environment fingerprints agree; configured channels have not failed; and the TUI endpoint is reachable. Only then does guided init open `mono-agent tui --configure` against that process. Start or timeout failure preserves the committed files, skips configuration chat, and prints exact `start`, `status`, and `logs --follow` recovery commands.

### Keyed background snapshot commitments

Exact background file bytes are committed with a per-config 256-bit HMAC key stored under owner-only `~/.mono-agent/background-snapshot-keys/`. The controller creates the key and managed workers load it. Process arguments and trace metadata contain neither the plaintext files nor an offline-testable unkeyed credential digest.

## Temporary configuration and rollback

The first TUI exchange after guided macOS setup is visibly separate temporary configuration mode, not ordinary chat. It tells the operator not to enter secrets and requires a host-rendered approval before any proposed change can be applied. Ordinary action tools and configured MCP servers are replaced with the narrow configuration capability for that request.

A proposal-free finish, rejection, successful approval, or recovered rollback transitions the console to a fresh ordinary conversation. Approval commits the files, restarts the agent, waits for its new ready source, and only then swaps the TUI endpoint. If the new configuration cannot start, the host restores the previous files and attempts to restart the prior agent. If neither the new start nor recovery can prove a live endpoint, queued ordinary messages are cancelled instead of being sent to stale local state. `/quit` closes the console but does not stop the background agent.

## Related references

| Topic | Canonical page |
| --- | --- |
| Install choices and source builds | [Install & Prerequisites](/getting-started/install/) |
| Complete first-agent workflow | [Your First Agent](/getting-started/quickstart/) |
| Dotenv precedence and secret fields | [Environment Variables](/config/env-vars/) |
| Agent-folder ownership and generated paths | [Folder Layout](/config/folder-layout/) |
| Exact command, readiness, and recovery behavior | [CLI Reference](/observability/cli-reference/) |
| Temporary configuration authority | [TUI](/observability/tui/) |
| Feature-level coverage contracts | [Feature Registry](/reference/feature-registry/) |
