// Dedicated bridge startup exit statuses: the parent never reads bridge stderr,
// which may contain paths or secrets. Only these fixed codes cross into PeerAgent.
const STARTUP_EXIT_CODES = {
  agent_unauthorized: 20,
  source_not_found: 21,
  source_not_running: 22,
  operator_unavailable: 23,
  bridge_metadata_unavailable: 24,
  bridge_version_unsupported: 25,
  tool_environment_unavailable: 26,
} as const;

export function bridgeStartupExitCode(code: unknown): number {
  return typeof code === "string" && Object.hasOwn(STARTUP_EXIT_CODES, code)
    ? STARTUP_EXIT_CODES[code as keyof typeof STARTUP_EXIT_CODES] : 1;
}

export function peerStartupDiagnostic(exitCode: number | null, sourceId: string): string | undefined {
  const cause = Object.entries(STARTUP_EXIT_CODES).find(([, status]) => status === exitCode)?.[0];
  if (cause === undefined) return undefined;
  const reason = cause === "agent_unauthorized" ? "operator API key was rejected"
    : cause === "source_not_found" ? "source was not found"
      : cause === "source_not_running" ? "source is not running"
        : cause === "operator_unavailable" ? "operator endpoint is unavailable"
          : cause === "bridge_metadata_unavailable" ? "ACP bridge metadata is unavailable"
            : cause === "bridge_version_unsupported" ? "ACP bridge version is unsupported"
              : "operator tool environment is unavailable";
  return `${reason} for source ${JSON.stringify(sourceId)} (${cause}); no prompt was replayed.`;
}
