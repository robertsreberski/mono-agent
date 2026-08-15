import type { MonoAgentAppConfigInput } from "./app-config.js";
import { resolveAppArtifactDir, resolveAppSessionsRoot } from "./app-config.js";
import { acpSessionAuthorizationsRoot } from "./acp-session-store.js";
import { agentArtifactDerivedRoots } from "./agent-artifact-paths.js";

/** Every filesystem root removed by `restart --clear-sessions`. */
export interface ConversationStatePurgeRoots {
  readonly sessions?: string;
  readonly history: string;
  readonly acpSessions: string;
}

/**
 * Resolve reset roots once so startup validation and the destructive purge path
 * remain bound to the same config/env precedence and derived directories.
 */
export async function resolveConversationStatePurgeRoots(
  input: MonoAgentAppConfigInput,
): Promise<ConversationStatePurgeRoots> {
  const [sessions, artifactDir] = await Promise.all([
    resolveAppSessionsRoot(input),
    resolveAppArtifactDir(input),
  ]);
  return {
    ...(sessions === undefined ? {} : { sessions }),
    history: agentArtifactDerivedRoots(artifactDir).history,
    acpSessions: acpSessionAuthorizationsRoot(artifactDir),
  };
}
