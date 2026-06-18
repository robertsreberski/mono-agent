# @mono-agent/settings

## Category

Category: `core`

## Responsibility

Generic settings primitives for agent hosts: field-group schemas, field read/write helpers, sparse patch validation, secret redaction, and atomic JSON settings storage. This package is adapter-neutral and can preserve unknown top-level JSON sections for future hosts or adapters.

## Install / Usage

```bash
pnpm --filter @mono-agent/settings run build
```

```ts
import {
  defineFieldGroup,
  readSettingsJson,
  validateSettingsPatch,
  writeSettingsJson,
} from "@mono-agent/settings";
```

Use `@mono-agent/settings/field-groups` from browser code when only field definitions and read/write helpers are needed.

## Public API

- `defineFieldGroup`, `readFieldValue`, `writeFieldValue`
- `validateSettingsPatch`
- `redactSettingsForFieldGroups`
- `readSettingsJson`, `writeSettingsJson`, `SettingsJsonError`
- `SettingsJson`, `FieldDefinition`, `FieldGroup`, `FieldGroupRegistry`, `FieldKind`

## Dependency Boundary

This package has no workspace runtime dependency. It is safe for core config loaders and adapter settings. Browser bundles should import only `@mono-agent/settings/field-groups`.

## What This Package Does Not Own

It does not define core agent config semantics, adapter-specific required fields, runtime model validation, UI rendering, or observability artifacts.

## Verification

```bash
pnpm --filter @mono-agent/settings run build
pnpm --filter @mono-agent/settings run typecheck
pnpm --filter @mono-agent/settings run test
```
