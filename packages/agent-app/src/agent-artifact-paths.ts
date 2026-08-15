import { resolve } from "node:path";

export interface AgentArtifactDerivedRoots {
  readonly attachments: string;
  readonly outbound: string;
  readonly history: string;
}

/** Paths whose ownership is derived from the configured artifact directory. */
export function agentArtifactDerivedRoots(artifactsDir: string): AgentArtifactDerivedRoots {
  const artifactRoot = resolve(artifactsDir);
  return {
    attachments: resolve(artifactRoot, "attachments"),
    outbound: resolve(artifactRoot, "outbound"),
    history: resolve(artifactRoot, "..", "history"),
  };
}
