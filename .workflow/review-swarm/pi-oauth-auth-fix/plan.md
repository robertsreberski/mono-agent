# Pi OAuth Auth Fix Review Swarm

## Scope

Review the current working-tree fix for the personal-agent provider auth failure:

- `packages/agent-runtime/src/pi-auth.js`
- `packages/agent-runtime/src/ai/providers/pi-native.js`
- `packages/agent-runtime/src/ai/providers/pi-native/result-builder.js`
- `packages/agent-runtime/src/ai/failure.js`
- `packages/agent-runtime/src/ai/runtime/router.js`
- `packages/observability/src/failure-kinds.ts`
- `packages/observability/src/summary-schema.ts`
- `packages/observability/src/types.ts`
- focused tests under `packages/agent-runtime/src/__tests__` and `packages/observability/src/__tests__`

Ignore unrelated dirty `packages/session-web/**` changes.

## Requirements

- Preserve Pi OAuth credentials as `{ type: "oauth", ... }` for OAuth-only providers such as `openai-codex`.
- Keep legacy string API-key resolver behavior working for API-key providers.
- Allow Pi OAuth refresh writes to persist through the injected credential store.
- Classify missing/invalid/refresh-failed provider credentials as `provider_auth`, not provider availability.
- Keep auth/config failures terminal and avoid rewriting them to `provider_unavailable_exhausted`.
- Keep retryable availability failures eligible for fallback and report exhaustion only after eligible retryable attempts fail.
- Update observability/audit display taxonomy for `provider_auth`.
- Provide regression tests and preserve package architecture.

## Verification Already Run

- `pnpm --filter @mono-agent/agent-runtime test -- src/__tests__/ai/pi-native.test.js src/__tests__/pi-auth.test.js src/__tests__/ai/failure.test.js src/__tests__/ai/router.test.js --runInBand`
- `pnpm --filter @mono-agent/observability test -- src/__tests__/failure-kinds.test.ts src/__tests__/artifact-audit.test.ts --runInBand`
- `pnpm --filter @mono-agent/agent-host test -- --runInBand`
- `pnpm run build`
- `pnpm run typecheck`
- `pnpm run check:architecture`
- `pnpm test`
- Live `personal-agent` loopback returned `OK_OAUTH_STORE`; artifact `run-mr7evg35-n89r0x` succeeded on `pi:openai-codex:gpt-5.5`; memory maintenance artifacts succeeded on `pi:openai-codex:gpt-5.4-mini`.
