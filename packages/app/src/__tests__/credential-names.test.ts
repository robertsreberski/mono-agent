import { expect, it } from "vitest";
import { resolveCredentialEnvironmentName } from "../setup/credential-names.js";

const credentials = [
  ["telegram-bot", "MONO_AGENT_TELEGRAM_BOT_TOKEN"],
  ["slack-bot", "MONO_AGENT_SLACK_BOT_TOKEN"],
  ["slack-app", "MONO_AGENT_SLACK_APP_TOKEN"],
  ["openai-client", "MONO_AGENT_OPENAI_API_KEY"],
  ["a2a-bearer", "MONO_AGENT_A2A_BEARER_TOKEN"],
  ["embeddings", "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY"],
  ["parallel", "PARALLEL_API_KEY"],
  ["ollama-hosted", "OLLAMA_API_KEY"],
] as const;
const operational = [
  "MONO_AGENT_A2A_ENABLED", "MONO_AGENT_A2A_REQUIRE_BEARER",
  "MONO_AGENT_TELEGRAM_ALLOWED_CHAT_IDS", "MONO_AGENT_SLACK_ALLOWED_CHANNEL_IDS",
  "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN", "MONO_AGENT_FUTURE_SETTING",
  "MONO_AGENT_CUSTOM_AUTH", "mono_agent_a2a_enabled",
  "MONO_AGENT_MANAGED_WORKER", "MONO_AGENT_SYSTEMD_WORKER", "MONO_AGENT_TUI_PORT",
  "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "NODE_OPTIONS",
  "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "BASH_ENV", "ENV", "IFS",
] as const;

it.each(credentials)("resolves %s only to its own exact default or a nonreserved custom name", (kind, ownDefault) => {
  expect(resolveCredentialEnvironmentName(kind)).toBe(ownDefault);
  expect(resolveCredentialEnvironmentName(kind, ` ${ownDefault} `)).toBe(ownDefault);
  for (const name of ["CUSTOM_SERVICE_AUTH", "model_key", "custom_KEY_2"]) expect(resolveCredentialEnvironmentName(kind, name)).toBe(name);
  expect(() => resolveCredentialEnvironmentName(kind, ownDefault.toLowerCase())).toThrow("Reserved or invalid credential environment name.");
});
it.each(credentials.flatMap(([kind, ownDefault]) => credentials.filter(([, name]) => name !== ownDefault).map(([, name]) => ({ kind, name }))))("refuses another credential's $name for $kind", ({ kind, name }) => {
  expect(() => resolveCredentialEnvironmentName(kind, name)).toThrow("Reserved or invalid credential environment name.");
});
it.each(credentials.flatMap(([kind]) => operational.map((name) => ({ kind, name }))))("refuses operational/allowlist/nondefault credential $name for $kind", ({ kind, name }) => {
  expect(() => resolveCredentialEnvironmentName(kind, name)).toThrow("Reserved or invalid credential environment name.");
});
