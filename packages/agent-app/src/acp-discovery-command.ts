import process from "node:process";

import { discoverAcpBridgeAgents } from "@mono-agent/web";

export interface RunAcpDiscoveryOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly output?: { write(chunk: string): unknown };
}

/** Print the public discovery result unchanged so CLI and library consumers share one contract. */
export async function runAcpDiscovery(options: RunAcpDiscoveryOptions = {}): Promise<number> {
  const result = await discoverAcpBridgeAgents({ env: options.env ?? process.env });
  (options.output ?? process.stdout).write(`${JSON.stringify(result)}\n`);
  return 0;
}
