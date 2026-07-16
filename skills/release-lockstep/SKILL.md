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

**Lockstep set:** all **21 `publishable: true` packages** in
`scripts/package-catalog.mjs` release together: 16 core packages (entries without
a `tier`), 1 `tier: "alias"` package (`create-mono-agent` under `packages/*`), and
4 `tier: "plugin"` extras under `extras/*` (a2a-adapter, agent-orchestrator,
memory-supermemory, and whatsapp-adapter). Plugin extras are version-bumped and
published alongside core.
`scripts/package-catalog.mjs` (`publishable: true`) is the source of truth, and
`release:test`'s package-count-drift check guards the tier and total counts.

## 1. Bump

Mechanically set the new version in every catalog-publishable `packages/*` and
`extras/*` package.json, root `package.json` devDependencies (`workspace:<new>`),
and demo/consumer manifests.
Then refresh the lockfile:

```bash
pnpm install
```

Two things `validateRelease` does **not** cover — check them by hand during the bump:

- **Root devDependency pins (#228).** The gate verifies every `packages/*`/`extras/*`
  version and their internal deps, but not the root `package.json`'s own
  `@mono-agent/*` devDependency pins. A pin left at the old version is invisible to
  the release gate — spot-check it against the target:

  ```bash
  # substitute <target-version> with the version you are cutting
  grep -oE '"@mono-agent/[^"]+": *"workspace:[^"]+"' package.json | grep -v 'workspace:<target-version>'
  # non-empty output = a root devDep pin the release gate will NOT catch (#228)
  ```

- **Stale hand-authored `_VERSION` literals.** A version string typed into source
  drifts silently: `TUI_PACKAGE_VERSION` fell 11 minor versions behind before anyone
  noticed. Grep for hand-authored version constants during every bump:

  ```bash
  grep -rnE "_VERSION\s*[:=]\s*[\"'][0-9]" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
  ```

  The ones meant to mirror their own package version (`TUI_PACKAGE_VERSION`) must be
  bumped, or — better — replaced with a build-time read of `package.json` so they
  can never drift again. Constants that version something independent
  (`MANAGED_SRT_VERSION`, `PROJECT_SKILL_VERSION`) are not release-coupled; don't
  bump those.

## 2. Preflight (exactly what CI will run)

```bash
pnpm run release:test
pnpm run release:validate -- --tag vX.Y.Z
pnpm run check:architecture && pnpm run build && pnpm run typecheck && pnpm test
pnpm run release:pack -- --tag vX.Y.Z
pnpm run release:consumer -- --tag vX.Y.Z --require-minimum
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

**Supply-chain attestation.** Neither this skill nor the release scripts request
npm provenance today, so every package ships **unattested**. The publish step
should carry `--provenance` (or move to npm trusted publishing) so each tarball
gets a signed provenance attestation bound to the CI run:

```bash
npm publish <tarball> --access <access> --tag <tag> --provenance
```

`--provenance` only produces a real attestation from a supported CI with OIDC
(GitHub Actions, `permissions: id-token: write`); a bare local `npm publish
--provenance` cannot generate one, which is another reason the local path in §4 is
not the normal one.

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
- **Downstream fleets: one version-derivation point.** When documenting how a
  downstream consumer/fleet tracks lockstep releases, have it derive the expected
  `@mono-agent` version at runtime from its own `package.json` (read
  `dependencies["@mono-agent/agent-app"]`) rather than duplicating the release
  string as a literal. One live instance hardcodes the version in **6 separate
  files** — every bump then needs 6 edits and any missed one drifts silently.
- Update memory/docs notes recording the release (version, date, anything
  retired or newly published).

## Deprecation aliases carry a removal version

Every deprecation alias/flag must ship with either a target removal version/date
or an explicit permanent-retention decision in the same commit that introduces
it. A deprecation with neither becomes accidental forever-compatibility. Record
a sunset in the message and/or a `@deprecated` JSDoc tag; record permanent
retention beside the compatibility branch or map. Keep both kinds of decision in
`docs/reference/deprecations.md`; when cutting a target release, remove every due
implementation/test/doc surface and its tracker row together.

`LEGACY_TOOL_ALIASES` is the deliberate permanent decision recorded there:
hand-written `allowedTools` / `disallowedTools` lists cannot be migrated safely,
and dropping a legacy deny-list match could broaden access. Do not schedule that
map for removal unless an explicit migration preserves both allow and deny
semantics for every existing config.
