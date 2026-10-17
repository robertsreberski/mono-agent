import type { MonoAgentConfig } from "@mono-agent/config";
import { loadContinuationSettings } from "../continuation-config.js";
import type { ValidationSection } from "../doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./options.js";
import { continuationReason } from "../diagnostics/inspection-values.js";
import { inspectContinuationState } from "../continuations/state-inspection.js";

export async function continuationSection(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
): Promise<ValidationSection> {
  let settings;
  try {
    settings = await loadContinuationSettings({
      cwd: input.cwd,
      configPath: input.configPath,
      env: input.env,
    });
  } catch (error) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: [`Continuation configuration is invalid: ${continuationReason(error)}`],
    };
  }

  const continuationServers = config.tools.continuationServers ?? [];
  if (!settings.configured && continuationServers.length === 0) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "disabled",
      details: ["No continuation-capable MCP servers or detached continuation routes are configured."],
    };
  }
  if (!settings.enabled) {
    return {
      id: "continuations",
      label: "Durable continuations",
      status: "error",
      details: ["Continuation service is disabled while continuation functionality is configured."],
    };
  }

  const details = [
    `Loopback service: http://${formatContinuationHost(settings.host)}:${String(settings.port)}.`,
    `Owner-only state: ${settings.stateDir}.`,
    continuationServers.length === 0
      ? "Run-scoped continuation MCP servers: none."
      : `Run-scoped continuation MCP servers: ${continuationServers.join(", ")}.`,
  ];
  const routeNames = Object.entries(settings.namedRoutes).map(([name, route]) => `${name} (${route.mode})`);
  details.push(routeNames.length === 0 ? "Named detached routes: none." : `Named detached routes: ${routeNames.join(", ")}.`);
  const detachedNames = Object.keys(settings.detachedServices);
  details.push(detachedNames.length === 0 ? "Detached services: none." : `Detached services: ${detachedNames.join(", ")}.`);

  const state = await inspectContinuationState(settings.stateDir, settings.retention);
  details.push(...state.details);
  return {
    id: "continuations",
    label: "Durable continuations",
    status: state.status,
    details,
  };
}

function formatContinuationHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
