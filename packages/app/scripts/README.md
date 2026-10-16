# App manual smoke index

These five standalone, by-path proof programs use real built app/runtime seams.
They are registered as non-production Knip entries, not dead fixtures. They do
not launch an interactive console, call a paid model, or install a supervisor.
Registration is not passing smoke evidence; choose and run a scenario explicitly.

Run from the repository root after:

```bash
pnpm install --frozen-lockfile
pnpm --filter '@mono-agent/app...' run build
```

| Program (relative to `packages/app/`) | Purpose | Run from repository root | Opt-in / prerequisites |
| --- | --- | --- | --- |
| `scripts/smoke-subagent-stop.mjs` | Real retained native stop/resume/close, paired tool evidence, and bounded stop of an uncooperative child without prematurely releasing capacity. | `node packages/app/scripts/smoke-subagent-stop.mjs` | Explicit local invocation; controlled transport. |
| `scripts/smoke-subagent-steer.mjs` | Steer a running managed subagent through the real Pi live-input path and verify the resulting context/evidence. | `node packages/app/scripts/smoke-subagent-steer.mjs` | Explicit local invocation; controlled transport. |
| `src/__tests__/fixtures/managed-subagent-proof.mjs` | Built ownership/job-store/process seam round-trip using controlled model transport. | `node packages/app/src/__tests__/fixtures/managed-subagent-proof.mjs 250` | Optional duration argument: integer milliseconds, 1–180000 (default 250). |
| `src/__tests__/fixtures/subagent-observer-srt.mjs` | Real sandboxed observation, including Git/submodule/include denial; refuses an unsandboxed fallback. | See scoped SRT invocation below. | **Opt-in real managed SRT**, functional on the host; checkout-scoped cwd, HOME, cache, TMPDIR, and Git required. |
| `src/__tests__/fixtures/worker-maintenance-smoke.mjs` | Built worker activity producer/helper round-trip; a busy ProcessJobs service prevents unattended maintenance stop. | `node packages/app/src/__tests__/fixtures/worker-maintenance-smoke.mjs` | Local child processes and `/bin/sleep`; no supervisor installation or model call. |

## Real-SRT opt-in

Only run this when intentionally exercising the real sandbox. Setup may download
managed SRT. Keep runtime state inside this checkout, not the operator's HOME:

```bash
mkdir -p .mono-agent/verification/srt-local/home .mono-agent/verification/srt-local/cache .mono-agent/t
HOME="$PWD/.mono-agent/verification/srt-local/home" \
XDG_CACHE_HOME="$PWD/.mono-agent/verification/srt-local/cache" \
TMPDIR="$PWD/.mono-agent/t" \
node packages/app/dist/cli.js sandbox setup

HOME="$PWD/.mono-agent/verification/srt-local/home" \
XDG_CACHE_HOME="$PWD/.mono-agent/verification/srt-local/cache" \
TMPDIR="$PWD/.mono-agent/t" \
node packages/app/src/__tests__/fixtures/subagent-observer-srt.mjs
```

The proof asserts the exact root cwd, HOME, and TMPDIR. On Darwin, use a checkout
path short enough for SRT's Unix socket limit; the `.mono-agent/t` component is
intentionally short. An unavailable sandbox is a failed/unverified proof, not a
reason to substitute an unsandboxed run.

Stop/steer and worker-maintenance use temporary roots below `node_modules/`.
Managed-subagent and SRT proofs use `.mono-agent/verification/` and normally
clean up their own scratch on success or failure. Set
`MONO_AGENT_KEEP_VERIFICATION_SCRATCH=1` only for deliberate post-mortem retention;
never commit retained scratch. The SRT installation/cache is intentionally
reusable across invocations.

See the [core source scan policy](../../../scripts/core-scans/README.md) for
pinned scan commands, scope, and the exact exception register. The manual proofs
are not run automatically by those scans or ordinary test commands.
