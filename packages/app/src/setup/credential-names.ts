import { isSystemdBackgroundOperationalEnvName } from "../service/background/background-environment.js";

// Keep credential defaults and reserved namespaces together. Host/session names
// reuse the lifecycle registry; framework flags need no growing enumeration.
const environmentNames = {
  credentials: {
    "telegram-bot": "MONO_AGENT_TELEGRAM_BOT_TOKEN",
    "slack-bot": "MONO_AGENT_SLACK_BOT_TOKEN",
    "slack-app": "MONO_AGENT_SLACK_APP_TOKEN",
    "openai-client": "MONO_AGENT_OPENAI_API_KEY",
    "a2a-bearer": "MONO_AGENT_A2A_BEARER_TOKEN",
    embeddings: "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
    parallel: "PARALLEL_API_KEY",
    "ollama-hosted": "OLLAMA_API_KEY",
  },
  operational: {
    prefixes: ["MONO_AGENT_", "NODE_", "LD_", "DYLD_", "PYTHON", "BASH"],
    names: ["ENV", "IFS"],
    isHostName: isSystemdBackgroundOperationalEnvName,
  },
} as const;
const credentialNames: ReadonlySet<string> = new Set(Object.values(environmentNames.credentials));
const operationalNames: ReadonlySet<string> = new Set(environmentNames.operational.names);

/** Resolve only when credential setup is selected; keyless callers must not add a requirement. */
export function resolveCredentialEnvironmentName(kind: keyof typeof environmentNames.credentials, configured?: string): string {
  const ownDefault = environmentNames.credentials[kind], name = configured?.trim() || ownDefault;
  const upper = name.toUpperCase();
  const reserved = credentialNames.has(upper) || operationalNames.has(upper)
    || environmentNames.operational.isHostName(upper)
    || environmentNames.operational.prefixes.some((prefix) => upper.startsWith(prefix));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || (name !== ownDefault && reserved)) throw new Error("Reserved or invalid credential environment name.");
  return name;
}
