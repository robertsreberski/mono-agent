# @worklab-ai/config-ui

Small browser configuration UI for Mono Agent hosts plus a loopback HTTP bridge that reads/writes `mono-agent.config.json`.

## What you get

- A React 19 single-page form built on **Tailwind v4 + shadcn/ui** primitives (radix-nova preset, neutral baseColor) — the same design system as the standalone Worklab `design-system` reference. Form-essentials subset only: `button`, `input`, `label`, `card`, `tabs`, `badge`, `separator`, `select`, `switch`.
- Tabs driven by a `FieldGroup` registry — five core groups (identity, runtime, memory, tools, telegram) ship in-box and hosts can register more.
- A tiny Node HTTP server (`startConfigUiBridge`) that serves the SPA, exposes `/api/schema`, `/api/config`, optional `/api/observability/*`, and `/api/health`, and persists edits atomically.
- Per-boot bearer-token auth, refusal to bind non-loopback hosts, secret redaction on GET, **schema-validated PUT** (unregistered field paths are rejected with 400 before disk is touched), and `expectedVersion` concurrency control on PUT.

## Install

```bash
npm install @worklab-ai/config-ui
```

This package is a workspace member of the Mono Agent monorepo; consumers outside this monorepo install it from npm.

## Usage

```ts
import {
  startConfigUiBridge,
  CORE_FIELD_GROUPS,
  defineFieldGroup,
} from "@worklab-ai/config-ui";

const bridge = await startConfigUiBridge({
  configPath: "/path/to/mono-agent.config.json",
  cwd: process.cwd(),
  observability: {
    artifactDir: "/path/to/.mono-agent/artifacts",
    maxRuns: 50,
    maxEventsPerRun: 500,
  },
  fieldGroups: [
    ...CORE_FIELD_GROUPS,
    defineFieldGroup({
      id: "telemetry",
      label: "Telemetry",
      fields: [
        {
          id: "telemetry.endpoint",
          label: "OTLP endpoint",
          kind: "string",
          path: ["telemetry", "endpoint"],
        },
      ],
    }),
  ],
});

console.log(bridge.url);   // http://127.0.0.1:<random-port>
console.log(bridge.token); // 64-char hex, paste as ?t= when opening URL

// Later
await bridge.stop();
```

Open `${bridge.url}/?t=${bridge.token}` in your browser. The SPA picks up the token, strips it from the URL bar, and uses an Authorization header for subsequent API calls.

## Field kinds

| Kind | Renders as | Persisted as |
| --- | --- | --- |
| `string` | text input | string |
| `path` | text input (hint: relative to `cwd`) | string |
| `csv` | text input | string\[\] (split on commas) |
| `integer` | number input with min/max | number |
| `select` | `<select>` with the field's `options` | string |
| `switch` | checkbox | boolean |
| `secret` | password input | string (write-only over the wire) |

`secret` values are never echoed in GET responses. The SPA shows a `SET` badge when the bridge reports `{ __secret: true, set: true }`. Submitting an empty `secret` clears the value on disk.

## HTTP contract

```
GET  /                        SPA shell (HTML + injected window.__CONFIG_UI__)
GET  /api/health              { ok: true }                                (no auth)
GET  /api/schema              { fieldGroups: FieldGroup[] }               (bearer)
GET  /api/config              { config: RedactedJson, version: string }   (bearer)
GET  /api/observability/runs  { enabled, artifactDir?, runs, warnings? }   (bearer)
GET  /api/observability/runs/:runId
                              { enabled, artifactDir?, run?, warnings? }   (bearer)
                              404 { error: "not_found" }
                              400 { error: "invalid_run_id" }
PUT  /api/config              { ok: true, version: string }               (bearer)
                              409 { error: "stale", currentVersion }
                              400 { error, message?, details? }
                              401 unauthorized
```

`PUT` body:

```ts
{
  patch: Partial<MonoAgentConfigJson>;
  expectedVersion: string;
}
```

The bridge validates the `patch` against the registered `FieldGroup` schema **before** touching disk. Every leaf path must correspond to a declared `FieldDefinition.path`; unknown leaves return:

```json
{
  "error": "unregistered_fields",
  "message": "Unregistered fields rejected: notRegistered.arbitrary.",
  "unregistered": ["notRegistered.arbitrary"],
  "invalid": []
}
```

Per-leaf coercion runs the value through the field's declared kind so out-of-range integers, unknown `select` options, and mistyped scalars are surfaced the same way. Hosts cannot smuggle arbitrary keys into `mono-agent.config.json` via the UI, even with a valid bearer token.

## Observability

When `observability` is provided, the bridge reads persisted `@worklab-ai/observability` JSON artifacts from that directory. The view is refresh-based: it lists recorded requests/runs and loads one selected run's redacted JSONL event timeline on demand. If observability is omitted, the endpoint returns a clear disabled state instead of demo data. If the artifact directory does not exist yet, the enabled response contains an empty run list.

Run ids are URL-decoded, must be non-empty, and cannot contain `/`, `\\`, or `..`; the server derives artifact file paths inside the configured directory rather than accepting request-provided paths.

## Safety

- Bind host is `127.0.0.1` by default; non-loopback values throw at start.
- Bearer token is 32 random bytes (hex), generated per boot.
- The on-disk JSON file is written with mode `0o600` via temp-file + rename, so a half-written file never overwrites a good one.
- Provider API keys stay outside this package; the existing env-based runtime configuration owns them.

## Public surface

```ts
import {
  startConfigUiBridge,
  defineFieldGroup,
  CORE_FIELD_GROUPS,
  readFieldValue,
  writeFieldValue,
} from "@worklab-ai/config-ui";

import type {
  ConfigUiBridgeOptions,
  ConfigUiBridgeStartResult,
  ConfigUiBridgeEvent,
  ConfigUiObservabilityOptions,
  FieldGroup,
  FieldDefinition,
  FieldKind,
  FieldGroupRegistry,
} from "@worklab-ai/config-ui";

import { CONFIG_UI_STATIC_DIR } from "@worklab-ai/config-ui/static";
```

## License

UNLICENSED (private to the Mono Agent workspace).
