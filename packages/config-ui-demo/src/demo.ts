import { resolve } from "node:path";

import {
  CORE_FIELD_GROUPS,
  startConfigUiBridge,
} from "@worklab-ai/config-ui";
import type { ConfigUiBridgeStartResult, FieldGroup } from "@worklab-ai/config-ui";

export interface DemoBridgeOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly fieldGroups?: readonly FieldGroup[];
  readonly port?: number;
}

export interface DemoBridgeResult extends ConfigUiBridgeStartResult {
  readonly configPath: string;
}

/**
 * Resolve options the way the CLI does, then start the bridge.
 *
 * Defaults:
 *   - cwd:        process.cwd()
 *   - configPath: <cwd>/mono-agent.config.json
 *   - fieldGroups: CORE_FIELD_GROUPS
 *   - port:       0 (let the OS pick a free port)
 */
export async function startDemoBridge(
  options: DemoBridgeOptions = {},
): Promise<DemoBridgeResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolve(cwd, "mono-agent.config.json");
  const fieldGroups = options.fieldGroups ?? CORE_FIELD_GROUPS;

  const result = await startConfigUiBridge({
    configPath,
    cwd,
    fieldGroups,
    ...(options.port === undefined ? {} : { port: options.port }),
  });

  return { ...result, configPath };
}
