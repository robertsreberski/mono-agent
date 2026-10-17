import { assertComputerUseServerNameAvailable, COMPUTER_USE_SERVER_NAME } from "../host/computer-use.js";
import { persistentSubagentsEnabled, subagentInstancesRoot } from "../subagents/subagent-instances.js";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import {
  classifyContinuationMcpServerTransport,
  isStdioMcpServerSpec,
  loadToolPolicyFromJsonFile,
} from "@mono-agent/conversation";
import { describeMonoRuntimeSupport } from "@mono-agent/turn/host";
import { isValidMcpServerName, modelReferenceKey } from "@mono-agent/turn/host/config";
import { networkPolicyAllowsUrl } from "@mono-agent/turn/host/sandbox";
import type { MonoAgentConfig } from "@mono-agent/config";
import { isRememberToolAllowed, isRememberToolPolicyName } from "../memory-remember.js";
import { isMemoryJournalToolAllowed, isMemoryJournalToolPolicyName } from "../memory-journal.js";
import { adapterSendToolNames, isAdapterSendToolAllowed, resolveAdapterSendToolsSettings } from "../delivery/send-tools/adapter-send-tools.js";
import { canonicalToolName, isAllowAllTools, isKnownToolName, isMcpToolName, renamedToolMessage, renamedToolName, suggestToolName } from "../modules/known-tools.js";
import { formatInteractionBridgeUrl, loadInteractionSettings } from "../mcp/interaction-bridge.js";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import type { ValidateMonoAgentFolderOptions } from "./options.js";
import { pathExists, displayReason, displayReferenceOf } from "./format.js";
import { piModelResolutionIssue } from "./runtime.js";

export async function toolsSection(config: MonoAgentConfig, input: ValidateMonoAgentFolderOptions): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  const allowedTools = config.tools.allowedTools;
  const allowAll = isAllowAllTools(allowedTools);
  if (allowAll) {
    // Allow-all (`"*"`): render the policy plainly instead of echoing the raw sentinel
    // as `Allowed tools: *.`. The disallow list (if any) is folded in as the "except"
    // clause here, so the separate `Disallowed tools:` line below is skipped for
    // allow-all to avoid printing it twice. Status stays `ok`; the per-name unknown /
    // MemoryRecall checks do not apply when every tool is allowed.
    details.push(
      config.tools.disallowedTools.length > 0
        ? `All tools allowed (except: ${config.tools.disallowedTools.join(", ")}).`
        : "All tools allowed.",
    );
  } else if (allowedTools.length === 0) {
    // An agent with no tools can chat but can do nothing else — the user's core
    // "no-tools trap". `waiting` (never `error`) surfaces it without failing a
    // deliberately chat-only agent (`report.ok` only checks for `error`).
    status = "waiting";
    details.push(
      "No tools allowed — the agent can chat but cannot read files, run commands, or send proactive messages. " +
        "Add names to tools.allowedTools (e.g. Read, Glob, Grep), or re-run `mono-agent init` in an empty folder to pick tools interactively.",
    );
  } else {
    details.push(`Allowed tools: ${allowedTools.join(", ")}.`);
    let mcpNoteAdded = false;
    for (const name of allowedTools) {
      const renamedTo = renamedToolName(name);
      if (renamedTo !== undefined) {
        // A renamed built-in has no alias, so the old entry grants nothing.
        status = "waiting";
        details.push(`${renamedToolMessage(name, "allowedTools")} The old name is not registered, so it grants nothing.`);
        continue;
      }
      if (isMemoryJournalToolPolicyName(name)) {
        // This app-owned MCP surface must be checked before the generic MCP
        // branch, using the same deny-wins spellings as runtime composition.
        if (!isMemoryJournalToolAllowed(config.tools)) {
          status = "waiting";
          details.push(
            `${name} is listed but tool policy still resolves to denied (deny wins, including the mcp__mono-agent-memory-journal__* spelling) - the tool will not be offered.`,
          );
        } else if (config.memory === undefined) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but no memory block is configured - chronological journal browsing will not work.`,
          );
        } else if (config.memory.recallTool?.enabled === false) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.recallTool.enabled is off - explicit memory read tools will not work.`,
          );
        }
        continue;
      }
      if (isRememberToolPolicyName(name)) {
        // Reconcile with the runtime's own resolution, which honours the
        // `mcp__mono-agent-memory-write__*` spellings and deny-wins. This check
        // must precede the generic MCP branch below.
        if (!isRememberToolAllowed(config.tools)) {
          status = "waiting";
          details.push(
            `${name} is listed but tool policy still resolves to denied (deny wins, including the mcp__mono-agent-memory-write__* spellings) - the tool will not be offered.`,
          );
          continue;
        }
        // Unlike MemoryRecall, Remember IS allowlist-gated, so listing it is
        // correct and required under a restrictive policy. It still needs a
        // configured memory block with the write surface left enabled.
        if (config.memory === undefined) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but no memory block is configured - durable writes will not work. Configure memory (or remove this entry).`,
          );
        } else if (config.memory.rememberTool?.enabled === false) {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.rememberTool.enabled is off - durable writes will not work. Enable memory.rememberTool (or remove this entry).`,
          );
        }
        continue;
      }
      if (isMcpToolName(name)) {
        // MCP tool names are owned by their servers; we cannot verify them offline.
        if (!mcpNoteAdded) {
          details.push("MCP tool names are provided by their servers and cannot be validated offline.");
          mcpNoteAdded = true;
        }
        continue;
      }
      // Accept both the new `MemoryRecall` and the legacy `memory_recall` alias.
      if (canonicalToolName(name) === "MemoryRecall") {
        // MemoryRecall is auto-provisioned from memory.recallTool.enabled and is NOT
        // allowlist-gated. Listing it is harmless redundancy WHEN recall is on, but a
        // real misconfiguration when it is off (the user expects a recall they won't get).
        if (config.memory?.recallTool?.enabled === true) {
          details.push(
            `${name} in allowedTools has no effect — recall is auto-provisioned by memory.recallTool.enabled (already on). You can remove this entry.`,
          );
        } else {
          status = "waiting";
          details.push(
            `${name} is in allowedTools but memory.recallTool.enabled is off — recall will not work. Enable memory.recallTool (or remove this entry).`,
          );
        }
        continue;
      }
      if (!isKnownToolName(name)) {
        status = "waiting";
        const suggestion = suggestToolName(name);
        details.push(
          `Unknown tool name "${name}"` +
            (suggestion !== undefined ? ` — did you mean ${suggestion}?` : "") +
            " (pi silently drops unknown names).",
        );
      }
    }
  }
  if (!allowAll && config.tools.disallowedTools.length > 0) {
    // Under allow-all the disallow list is already folded into the "except" clause above.
    details.push(`Disallowed tools: ${config.tools.disallowedTools.join(", ")}.`);
  }
  for (const name of config.tools.disallowedTools) {
    // A stale deny entry is the dangerous direction of a rename: it stops
    // matching and silently broadens access to the renamed tool.
    if (renamedToolName(name) !== undefined) {
      status = "waiting";
      details.push(`${renamedToolMessage(name, "disallowedTools")} The old name denies nothing.`);
    }
  }
  let configuredMcpServerNames: string[] = [];
  let configuredMcpServers: Record<string, unknown> = {};
  if (config.tools.mcpConfigPath !== undefined) {
    if (await pathExists(config.tools.mcpConfigPath)) {
      details.push(`MCP config: ${config.tools.mcpConfigPath}`);
      try {
        const policy = await loadToolPolicyFromJsonFile(config.tools.mcpConfigPath);
        configuredMcpServers = policy.mcpServers ?? {};
        configuredMcpServerNames = Object.keys(configuredMcpServers);
      } catch {
        status = "error";
        details.push(`MCP config is malformed or unreadable: ${config.tools.mcpConfigPath}`);
      }
    } else {
      status = "error";
      details.push(`MCP config file is missing: ${config.tools.mcpConfigPath}`);
    }
  }
  if (config.tools.computerUse !== undefined) {
    try {
      assertComputerUseServerNameAvailable(configuredMcpServers);
      configuredMcpServers[COMPUTER_USE_SERVER_NAME] = { command: config.tools.computerUse.command ?? "cua-driver", args: ["mcp"] };
      configuredMcpServerNames = Object.keys(configuredMcpServers);
      details.push("Computer-use MCP server is configured; external MCP tools bypass built-in allow/deny policy.");
    } catch (error) {
      status = "error";
      details.push(error instanceof Error ? error.message : "Computer-use MCP server name collision.");
    }
  }
  for (const serverName of config.tools.mcpRequestContextServers ?? []) {
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (!isStdioMcpServerSpec(spec)) {
      status = "error";
      details.push(
        `tools.mcpRequestContextServers entry "${serverName}" must reference a stdio MCP server (command/type:stdio), not HTTP/SSE.`,
      );
    }
  }
  for (const serverName of config.tools.continuationServers ?? []) {
    if (!isValidMcpServerName(serverName)) {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" is not a runtime-valid MCP server name (letters, digits, underscores, and hyphens only).`,
      );
      continue;
    }
    const spec = configuredMcpServers[serverName];
    if (spec === undefined) {
      status = "error";
      details.push(
        `tools.continuationServers names unknown MCP server "${serverName}"; declare it in tools.mcpConfigPath.`,
      );
      continue;
    }
    if (classifyContinuationMcpServerTransport(spec) === "unsupported") {
      status = "error";
      details.push(
        `tools.continuationServers entry "${serverName}" must reference a stdio or loopback HTTP MCP server; remote HTTP and SSE are not supported.`,
      );
    }
  }
  const adapterSendTools = await resolveAdapterSendToolsSettings(input, {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  });
  if (adapterSendTools === undefined) {
    details.push("No adapter-derived send tools enabled.");
  } else {
    details.push(`Adapter send tools: ${adapterSendToolNames(adapterSendTools).join(", ")}.`);
  }
  const blockedAdapterEndpoints = await adapterSendToolNetworkPolicyWarnings(
    config,
    input,
    adapterSendTools,
  );
  if (blockedAdapterEndpoints.length > 0) {
    if (status !== "error") {
      status = "waiting";
    }
    details.push(...blockedAdapterEndpoints);
  }
  // Subagents: the Agent tool is registered only when BOTH the capability is
  // enabled and the tool is allowed, so surface either half being missing.
  const subagents = config.subagents;
  const agentAllowed = (allowAll || allowedTools.includes("Agent")) && !config.tools.disallowedTools.includes("Agent");
  if (subagents?.enabled === true) {
    if (subagents.instances?.enabled !== false && !persistentSubagentsEnabled(config)) {
      details.push("Persistent subagents unavailable: effective tool policy must expose both Agent and AgentManage; Agent remains stateless when allowed.");
    }
    if (persistentSubagentsEnabled(config)) {
      details.push(config.tools.disallowedTools.includes("AskParent")
        ? "AskParent dialogue disabled by global tool policy (operator choice)."
        : "AskParent is automatic inside persistent children only; profile denies can disable dialogue.");
      const root = subagentInstancesRoot(config);
      let ancestor = root;
      try {
        while (true) {
          try { const info = await stat(ancestor); if (!info.isDirectory()) throw new Error("not a directory"); await access(ancestor, constants.W_OK); break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = resolve(ancestor, "..");
            if (parent === ancestor) throw error;
            ancestor = parent;
          }
        }
        details.push(`Persistent subagents: ${root}; maxPerConversation ${subagents.instances?.maxPerConversation ?? 8}, idleTtlMs ${subagents.instances?.idleTtlMs ?? 86_400_000}, maxTurns ${subagents.instances?.maxTurns ?? 60}.`);
      } catch (error) { status = "error"; details.push(`subagents.instances.root is not creatable/writable: ${displayReason(error)}.`); }
      const cap = subagents.instances?.maxPerConversation ?? 8;
      if (!Number.isInteger(cap) || cap < 1 || cap > 32) { status = "error"; details.push("subagents.instances.maxPerConversation must be an integer from 1 to 32."); }
    }
    const count = subagents.definitions?.length ?? 0;
    const inline = subagents.inline?.enabled === false
      ? "; call-time authoring off"
      : `; call-time authoring on${subagents.inline?.allowedTools === undefined ? "" : ` (capped at ${subagents.inline.allowedTools.join(", ")})`}`;
    details.push(`Subagents: enabled, ${count} profile${count === 1 ? "" : "s"}${count === 0 ? " (general-purpose only)" : ""}${inline}.`);
    // Whether children inherit the parent's skill index and the ReadSkill tool.
    // Worth stating either way: a subagent that has neither must rediscover by
    // trial and error whatever the parent could have looked up, and that shows
    // up as wasted turns rather than as an error anyone would report.
    if (config.context?.skillsRoot === undefined) {
      details.push("Subagents get no skill index (no context.skillsRoot is configured).");
    } else if ((config.context.skillDisclosure ?? "full") !== "index") {
      details.push(
        "Subagents get no skill index because context.skillDisclosure is \"full\"; set it to \"index\" so subagents inherit the index and the ReadSkill tool.",
      );
    } else {
      details.push("Subagents inherit the parent's skill index and the ReadSkill tool.");
    }
    for (const tool of subagents.inline?.allowedTools ?? []) {
      if (!isKnownToolName(tool) && !isMcpToolName(tool)) {
        status = "error";
        details.push(`subagents.inline.allowedTools lists unknown tool "${tool}".`);
      }
    }
    if (!agentAllowed) {
      status = status === "error" ? status : "waiting";
      details.push(
        "Subagents are enabled but Agent is not in tools.allowedTools, so the tool is never registered. Add \"Agent\" to tools.allowedTools.",
      );
    }
    const subagentNames = new Set(["general-purpose", ...(subagents.definitions ?? []).map((definition) => definition.name)]);
    for (const [index, choice] of (subagents.models ?? []).entries()) {
      const name = choice.name ?? modelReferenceKey(choice.model);
      if (subagentNames.has(name)) {
        status = "error";
        details.push(`subagents.models[${index}] name "${name}" collides with a subagent name.`);
      }
      try {
        const support = describeMonoRuntimeSupport(choice.model);
        const issue = piModelResolutionIssue(config, choice.model);
        if (issue !== undefined) {
          status = "error";
          details.push(`subagents.models[${index}] (${name}): ${issue}.`);
        } else {
          details.push(`Subagent model "${name}" ${displayReferenceOf(choice.model)} runs on ${support.backend.label}.`);
        }
      } catch (error) {
        status = "error";
        details.push(`subagents.models[${index}] (${name}): ${displayReason(error)}.`);
      }
    }
    for (const definition of subagents.definitions ?? []) {
      if (definition.promptPath !== undefined && !(await pathExists(definition.promptPath))) {
        status = "error";
        details.push(`Subagent "${definition.name}" promptPath does not exist: ${definition.promptPath}`);
      }
      for (const tool of definition.allowedTools ?? []) {
        if (!isKnownToolName(tool) && !isMcpToolName(tool)) {
          status = "error";
          details.push(`Subagent "${definition.name}" allows unknown tool "${tool}".`);
        }
      }
      for (const server of definition.mcpServers ?? []) {
        if (configuredMcpServerNames.length > 0 && !configuredMcpServerNames.includes(server)) {
          status = "error";
          details.push(`Subagent "${definition.name}" references MCP server "${server}", which is not in tools.mcpConfigPath.`);
        }
      }
    }
  } else if (agentAllowed && !allowAll) {
    // Naming `Agent` in an enumerated allowlist is an explicit request for it, so
    // half-configuration is a real mistake and blocks readiness.
    status = status === "error" ? status : "waiting";
    details.push(
      "Agent is allowed but subagents.enabled is not true, so the tool is never registered. Set subagents.enabled to true or drop Agent from tools.allowedTools.",
    );
  } else if (allowAll) {
    // Under `["*"]` nobody asked for `Agent` specifically — the wildcard merely
    // includes it — so this is NOT a misconfiguration and must not affect status,
    // or every default wildcard agent would report "waiting".
    //
    // It still gets a line, because the wildcard was previously the one posture
    // with no signal in either direction: an operator could ask the agent to
    // delegate, watch it silently not do so, and find nothing here saying why.
    details.push(
      "Subagents: off (subagents.enabled is not true), so the Agent tool is not registered and the agent cannot delegate.",
    );
  }

  return { id: "tools", label: "Tools & MCP", status, details };
}

interface AdapterEndpointRequirement {
  readonly label: string;
  readonly tools: readonly string[];
  readonly url: string;
}

/**
 * Adapter-send tools run in a stdio MCP child governed by the native SRT
 * policy. Channel readiness alone therefore is not enough: the child also
 * needs the remote adapter API (or the app-owned interaction bridge) admitted
 * by sandbox.network.
 */
async function adapterSendToolNetworkPolicyWarnings(
  config: MonoAgentConfig,
  input: ValidateMonoAgentFolderOptions,
  settings: Awaited<ReturnType<typeof resolveAdapterSendToolsSettings>>,
): Promise<readonly string[]> {
  if (config.sandbox === undefined || config.sandbox.mode !== "native") {
    return [];
  }

  const toolNames = settings === undefined ? [] : adapterSendToolNames(settings);
  const requirements: AdapterEndpointRequirement[] = [];
  if (settings?.slack !== undefined) {
    requirements.push({
      label: "Slack adapter-send API",
      tools: ["SlackSendMessage"],
      url: "https://slack.com/api",
    });
  }
  if (settings?.telegram !== undefined) {
    requirements.push({
      label: "Telegram adapter-send API",
      tools: toolNames.filter((name) => name.startsWith("Telegram")),
      url: settings.telegram.apiRoot ?? "https://api.telegram.org",
    });
  }

  const askUserAllowed = isAdapterSendToolAllowed("AskUser", {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
  });
  const bridgeTools = [
    ...(askUserAllowed ? ["AskUser"] : []),
  ];
  if (bridgeTools.length > 0) {
    const configuredBridgeUrl = input.env.MONO_AGENT_INTERACTION_BRIDGE_URL?.trim();
    const interaction = await loadInteractionSettings(input);
    const bridgeUrl = configuredBridgeUrl === undefined || configuredBridgeUrl.length === 0
      ? formatInteractionBridgeUrl(interaction.host, interaction.port)
      : configuredBridgeUrl;
    requirements.push({ label: "AskUser interaction bridge", tools: bridgeTools, url: bridgeUrl });
  }

  return requirements.flatMap((requirement) => {
    if (adapterSendChildNetworkAllowsUrl(config, requirement.url)) {
      return [];
    }
    const host = endpointHost(requirement.url);
    const allowlistHost = host === "::1" ? "localhost" : host;
    return [
      `Native sandbox network policy blocks ${requirement.label} host "${host}", required by ${requirement.tools.join(", ")}. ` +
        `Set sandbox.network.mode to "allowlist" and add "${allowlistHost}" to sandbox.network.allowlist, ` +
        `or disable ${requirement.tools.join(", ")}.`,
    ];
  });
}

function adapterSendChildNetworkAllowsUrl(config: MonoAgentConfig, url: string): boolean {
  if (networkPolicyAllowsUrl(config.sandbox, url)) return true;
  if (config.sandbox?.mode !== "native" || config.sandbox.network.mode !== "allowlist") return false;
  const host = endpointHost(url);
  return isLoopbackEndpointHost(host) && config.sandbox.network.allowlist.some(isLoopbackEndpointHost);
}

function isLoopbackEndpointHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.split(".")[0] === "127");
}

function endpointHost(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return url;
  }
}
