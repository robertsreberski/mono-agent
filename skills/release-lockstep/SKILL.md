---
name: release-lockstep
description: Cut a lockstep npm release of all @mono-agent packages (version bump → verify → tag → CI publish → post-verify). Use when asked to "release", "publish to npm", "cut vX.Y.Z", or "bump the version".
---

# Lockstep npm release

All catalog-publishable packages release in lockstep: `scripts/release/validate-release.mjs`
requires every `packages/*/package.json` version to equal the tag version and
every internal dep (including root devDependencies) to be `workspace:<version>`.
Publishing happens in CI on tag push (`.github/workflows/npm-release.yml`) —
local `npm publish` is NOT the normal path.

**Lockstep set (2026-07, updated #165):** all **20 `publishable: true` packages**
in `scripts/package-catalog.mjs` release together. 17 are the core app closure
under `packages/*`; the three plugin-tier extras under `extras/*` (a2a-adapter,
agent-orchestrator, whatsapp-adapter, marked `tier: "plugin"`) rejoined the
lockstep in #165 and are version-bumped and published alongside core.
`scripts/package-catalog.mjs` (`publishable: true`) is the source of truth, and
`release:test`'s package-count-drift check guards both the core (17) and
plugin-tier (3) counts.

## 1. Bump

Mechanically set the new version in every catalog-publishable `packages/*` and
`extras/*` package.json, root `package.json` devDependencies (`workspace:<new>`),
and demo/consumer manifests.
Then refresh the lockfile:

```bash
pnpm install
```

## 2. Preflight (exactly what CI will run)

```bash
pnpm run release:test
pnpm run release:validate -- --tag vX.Y.Z
pnpm run check:architecture && pnpm run build && pnpm run typecheck && pnpm test
pnpm run release:pack -- --tag vX.Y.Z
git diff --check
```

Do not tag until all of the above are green locally. `release:test` also catches
package-count drift (a package missing from the release graph).

## 3. Tag → CI publishes

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
gh run list --limit 5
gh run watch <id>            # or: gh run view <id> --json status,conclusion
```

The workflow: validate → check:architecture → build → typecheck → test → pack →
publish (NPM_TOKEN) → verify metadata → smoke-installs `@mono-agent/tui` and
`@mono-agent/agent-app` CLIs from the public registry.

## 4. Post-verify (registry gotcha)

The local AutoProxxy `.npmrc` breaks npm reads/writes against npmjs. Always pin
the registry or blank the userconfig (CI uses `NPM_CONFIG_USERCONFIG=/dev/null`):

```bash
pnpm run release:verify -- --tag vX.Y.Z
npm view @mono-agent/agent-app version --registry https://registry.npmjs.org/
npm view @mono-agent/agent-app version --userconfig /dev/null
npm whoami --registry https://registry.npmjs.org/     # only if publishing locally
```

Fresh-publish visibility can lag; retry `npm view` for a minute before declaring
failure (the CI smoke step retries for ~150s).

## 5. Aftercare

- The fleet still runs this repo's dist — decide whether to redeploy
  (`fleet-deploy` skill) so live agents match the published version.
- Package deprecations are done via the npm web UI, not the CLI (works around
  the proxy npmrc).
- Update memory/docs notes recording the release (version, date, anything
  retired or newly published).
