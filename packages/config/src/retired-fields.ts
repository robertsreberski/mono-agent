

import { normalizeOptionalString } from "@mono-agent/contracts";

import { MonoAgentConfigError } from "./errors.js";

import { isRecord } from "./parse/scalars.js";

/**
 * Retired settings stay explicit here so every loader entry point gives the
 * same repair instead of silently dropping a fallback chain or surfacing an
 * unactionable unknown-key error from a host-owned schema.
 *
 * `message` repairs the JSON key the operator actually edits. Stale
 * `MONO_AGENT_*` environment variables are silently ignored and never reported
 * here: there is no surface left that reads them.
 */
interface RetiredConfigField {
  readonly path: string;
  readonly message: string;
  /** Return true only when the legacy JSON value represented active behavior. */
  readonly jsonValueIsActive?: (value: unknown) => boolean;
}

function retiredObservabilityJsonIsActive(value: unknown): boolean {
  if (!isRecord(value) || Array.isArray(value)) return true;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  if (keys.length !== 1 || keys[0] !== "exporters") return true;
  return !Array.isArray(value.exporters) || value.exporters.length !== 0;
}

function retiredSupermemorySelectorIsActive(value: unknown): boolean {
  return typeof value === "string" && normalizeOptionalString(value) === "supermemory";
}

function retiredSupermemoryBlockIsActive(value: unknown): boolean {
  return !isRecord(value) || Array.isArray(value) || Object.keys(value).length !== 0;
}

const RETIRED_SUPERMEMORY_SELECTOR_JSON_MESSAGE =
  "`memory.backend` no longer accepts `supermemory`: first-party Supermemory support was removed. Remove the selector before upgrading. mono-agent does not select a replacement or migrate remote data; remote data remains untouched.";

const RETIRED_SUPERMEMORY_BLOCK_JSON_MESSAGE =
  "`memory.supermemory` was removed with first-party Supermemory support. Remove the block before upgrading. mono-agent does not select a replacement or migrate remote data; remote data remains untouched.";

const RETIRED_CONFIG_FIELDS: readonly RetiredConfigField[] = [
  {
    path: "runtime.permissionMode",
    message: "`runtime.permissionMode` was removed because the Pi runtime never enforced it. Delete the key; configure `sandbox` for enforced tool isolation.",
  },
  {
    path: "tools.web.search.hound.endpoint",
    message: "`tools.web.search.hound.endpoint` was removed: local search is built in. Delete the endpoint setting; no external service is contacted.",
  },
  {
    path: "tools.web.fetch.hound.endpoint",
    message: "`tools.web.fetch.hound.endpoint` was removed: local fetch is built in. Delete the endpoint setting; no external service is contacted.",
  },
  {
    path: "runtime.executionMode",
    message: "`runtime.executionMode` was removed; mono-agent runs only the Pi runtime (SDK). Delete the key.",
  },
  {
    path: "runtime.routeSafety",
    message: "`runtime.routeSafety` was removed; every route is Pi-native, so `per-route-native` has no meaning. Delete the key.",
  },
  {
    path: "runtime.fallbackModels",
    message: "`runtime.fallbackModels` was replaced by `runtime.fallbacks: [{ \"model\": \"...\" }]`. Replace the key with that shape.",
  },
  {
    path: "memory.backend",
    message: RETIRED_SUPERMEMORY_SELECTOR_JSON_MESSAGE,
    jsonValueIsActive: retiredSupermemorySelectorIsActive,
  },
  {
    path: "memory.supermemory",
    message: RETIRED_SUPERMEMORY_BLOCK_JSON_MESSAGE,
    jsonValueIsActive: retiredSupermemoryBlockIsActive,
  },
  {
    path: "memory.llm.executionMode",
    message: "`memory.llm.executionMode` was removed for the same reason as `runtime.executionMode`: mono-agent runs only the Pi runtime (SDK). Delete the key.",
  },
  {
    path: "observability",
    message: "`observability.exporters` was removed with first-party Phoenix/OTLP export. Remove the active exporter block before upgrading. Local run artifacts are unchanged and mono-agent does not select a replacement. If a final export is required, perform it before upgrading with the known-good version you already operate.",
    jsonValueIsActive: retiredObservabilityJsonIsActive,
  },
] as const;

/**
 * Reject active retired fields on any config-shaped object, including direct
 * JavaScript callers that bypass the JSON loader. Diagnostics name
 * only stable field paths and migration guidance; retired values are never
 * included because they may contain credentials or private service locations.
 */
export function assertNoRetiredMonoAgentConfig(config: object): void {
  const retired = RETIRED_CONFIG_FIELDS.filter((field) => {
    const found = ownConfigPathValue(config, field.path);
    if (!found.present) return false;
    return field.jsonValueIsActive?.(found.value) ?? true;
  });
  if (retired.length === 0) return;
  throw new MonoAgentConfigError("invalid_json", retired.map((field) => field.message).join(" "), {
    path: retired[0]!.path,
    paths: retired.map((field) => field.path),
  });
}

function ownConfigPathValue(config: object, path: string): { readonly present: boolean; readonly value?: unknown } {
  let current: unknown = config;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || Array.isArray(current)) return { present: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: current };
}

/**
 * Reject removed JSON fields before a host's generic unknown-key validation.
 *
 * Reports every retired key present, not just the first: migrating by hand is one edit
 * pass, and a config carrying multiple retired keys used to surface them one re-run at a
 * time. `path` stays the first match so existing single-key consumers are unchanged;
 * `paths` carries the full set.
 */
export function assertNoRetiredMonoAgentConfigJson(json: object): void {
  assertNoRetiredMonoAgentConfig(json);
  // JSON-only: resolved configs never carry this key, and checking it there would
  // read provider settings during retired-field rejection.
  const providers = (json as { providers?: unknown }).providers;
  const native = isJsonRecord(providers) ? providers.piNative : undefined;
  if (isJsonRecord(native) && hasRetiredPiSessionsRoot(native)) {
    throw new MonoAgentConfigError("invalid_json",
      "providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there",
      { path: "providers.piNative.piSessionsRoot", paths: ["providers.piNative.piSessionsRoot"] });
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Presence only: callers retain their own container guards and diagnostics. */
export function hasRetiredPiSessionsRoot(value: unknown): boolean {
  return value !== null && typeof value === "object" && Object.hasOwn(value, "piSessionsRoot");
}
