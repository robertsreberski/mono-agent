// Migration diagnostics only: no resolution aliases or compatibility imports.
const PACKAGE_RENAMES: Readonly<Record<string, string>> = {
  "@mono-agent/agent-app": "@mono-agent/app",
  "@mono-agent/agent-harness": "@mono-agent/conversation",
  "@mono-agent/agent-runtime": "@mono-agent/turn",
  "@mono-agent/agent-contracts": "@mono-agent/contracts",
  "@mono-agent/slack-adapter": "@mono-agent/channel-slack",
  "@mono-agent/telegram-adapter": "@mono-agent/channel-telegram",
  "@mono-agent/openai-api-adapter": "@mono-agent/channel-openai-api",
  "@mono-agent/operator-adapter": "@mono-agent/channel-operator",
  "@mono-agent/cron-adapter": "@mono-agent/trigger-cron",
  "@mono-agent/webhook-adapter": "@mono-agent/trigger-webhook",
  "@mono-agent/whatsapp-adapter": "@mono-agent/channel-whatsapp",
  "@mono-agent/messenger-adapter": "@mono-agent/channel-messenger",
  "@mono-agent/a2a-adapter": "@mono-agent/channel-a2a",
  "@mono-agent/agent-orchestrator": "@mono-agent/orchestrator",
};

/** Return an actionable error for a retired npm specifier, including version pins. */
export function packageRenameError(specifier: string, location: string): string | undefined {
  for (const [oldName, newName] of Object.entries(PACKAGE_RENAMES)) {
    if (specifier === oldName || specifier.startsWith(`${oldName}@`) || specifier.startsWith(`${oldName}/`)) {
      return `${oldName} was renamed to ${newName}; update ${location}`;
    }
  }
  return undefined;
}
