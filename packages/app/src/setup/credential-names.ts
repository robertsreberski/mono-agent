import { isSystemdBackgroundOperationalEnvName } from "../service/background/background-environment.js";

const defaults = {
  "telegram-bot": "MONO_AGENT_TELEGRAM_BOT_TOKEN",
  "slack-bot": "MONO_AGENT_SLACK_BOT_TOKEN",
  "slack-app": "MONO_AGENT_SLACK_APP_TOKEN",
  "openai-client": "MONO_AGENT_OPENAI_API_KEY",
  "a2a-bearer": "MONO_AGENT_A2A_BEARER_TOKEN",
  embeddings: "MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY",
  parallel: "PARALLEL_API_KEY",
  "ollama-hosted": "OLLAMA_API_KEY",
} as const;

/** Resolve only when credential setup is selected; keyless callers must not add a requirement. */
export function resolveCredentialEnvironmentName(kind: keyof typeof defaults, configured?: string): string {
  const name = configured?.trim() || defaults[kind];
  const upper = name.toUpperCase();
  if ((Object.values(defaults) as readonly string[]).some((reserved) => reserved === upper && reserved !== defaults[kind]) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || isSystemdBackgroundOperationalEnvName(upper) || /^(?:NODE_|LD_|DYLD_|PYTHON|BASH|ENV$|IFS$|MONO_AGENT_(?:MANAGED_|SYSTEMD_|TUI_|PROCESS_JOBS_|CONTINUATION|INTERACTION|NOTIFICATION))/u.test(upper)) throw new Error("Reserved or invalid credential environment name.");
  return name;
}
