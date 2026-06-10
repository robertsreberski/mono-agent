import {
  startA2AProvider,
} from "@mono-agent/a2a-adapter";
import type { A2AProviderStartResult } from "@mono-agent/a2a-adapter";
import {
  createConfiguredAgentResponder,
} from "@mono-agent/agent-host";
import type { AgentResponder } from "@mono-agent/agent-contracts";
import {
  loadMonoAgentConfig,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createClaudeAgentsRuntime } from "@mono-agent/claude-agents-runtime";
import { createOpenAIAgentsRuntime } from "@mono-agent/openai-agents-runtime";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import type { MonoRuntimeLike, RuntimeModelReference } from "@mono-agent/runtime-adapter";

export type AgentsSdkRuntimeName = "claude" | "openai" | "codex";

export interface AgentsSdkRuntimeChoice {
  readonly name: AgentsSdkRuntimeName;
  readonly model: RuntimeModelReference;
  readonly port: number;
  readonly cardSkillId: string;
  readonly cardSkillName: string;
  readonly cardDescription: string;
}

export const DEFAULT_AGENTS_SDK_CHOICES: readonly AgentsSdkRuntimeChoice[] = [
  {
    name: "claude",
    model: { sdk: "anthropic", model: "claude-opus-4-7" },
    port: 41100,
    cardSkillId: "claude-agent-skill",
    cardSkillName: "Claude Agents SDK runtime",
    cardDescription: "Agent backed by @anthropic-ai/claude-agent-sdk with Claude Code's built-in tools.",
  },
  {
    name: "openai",
    model: { sdk: "openai", model: "gpt-5" },
    port: 41101,
    cardSkillId: "openai-agent-skill",
    cardSkillName: "OpenAI Agents SDK runtime",
    cardDescription: "Agent backed by @openai/agents (MCP-attached tools, no local file/shell).",
  },
  {
    name: "codex",
    model: { sdk: "codex", model: "gpt-5.5" },
    port: 41102,
    cardSkillId: "codex-agent-skill",
    cardSkillName: "Codex app-server runtime",
    cardDescription: "Agent backed by the OpenAI Codex CLI (spawned app-server via stdio JSON-RPC).",
  },
];

export interface AgentsSdkDemoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly choices?: readonly AgentsSdkRuntimeChoice[];
  readonly logger?: AgentsSdkDemoLogger;
}

export interface AgentsSdkDemoLogger {
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

export type AgentsSdkRuntimeStatus =
  | { readonly name: AgentsSdkRuntimeName; readonly kind: "running"; readonly agentCardUrl: string; readonly model: RuntimeModelReference }
  | { readonly name: AgentsSdkRuntimeName; readonly kind: "skipped"; readonly reason: string };

export interface AgentsSdkDemoResult {
  readonly config: MonoAgentConfig;
  readonly statuses: readonly AgentsSdkRuntimeStatus[];
  stop(): Promise<void>;
}

export async function startAgentsSdkDemo(options: AgentsSdkDemoOptions = {}): Promise<AgentsSdkDemoResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const config = loadMonoAgentConfig({ env, cwd });
  const choices = options.choices ?? DEFAULT_AGENTS_SDK_CHOICES;
  const logger = options.logger;

  const statuses: AgentsSdkRuntimeStatus[] = [];
  const stoppers: Array<() => Promise<void>> = [];

  for (const choice of choices) {
    const decision = chooseRuntime(choice, env);
    if (decision.kind === "skipped" || decision.runtime === undefined) {
      const reason = decision.reason ?? "Runtime not available";
      statuses.push({ name: choice.name, kind: "skipped", reason });
      logger?.warn?.(`Skipping ${choice.name}: ${reason}`);
      continue;
    }

    const responder = createConfiguredAgentResponder({
      config,
      runtime: decision.runtime,
      model: choice.model,
    });

    const provider = await startA2AProvider({
      host: "127.0.0.1",
      port: choice.port,
      responder: responder as AgentResponder<never, never, never>,
      agent: {
        name: `${choice.name}-agent`,
        description: choice.cardDescription,
        version: "0.1.0",
      },
      skill: {
        id: choice.cardSkillId,
        name: choice.cardSkillName,
        description: choice.cardDescription,
      },
    });
    statuses.push({
      name: choice.name,
      kind: "running",
      agentCardUrl: provider.agentCardUrl,
      model: choice.model,
    });
    logger?.info?.(`${choice.name} agent listening at ${provider.agentCardUrl}`);
    stoppers.push(() => provider.stop());
  }

  return {
    config,
    statuses,
    async stop(): Promise<void> {
      for (const stop of stoppers) {
        try {
          await stop();
        } catch (error) {
          logger?.warn?.(`Error stopping provider: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}

interface RuntimeDecision {
  readonly kind: "ready" | "skipped";
  readonly runtime?: MonoRuntimeLike;
  readonly reason?: string;
}

function chooseRuntime(
  choice: AgentsSdkRuntimeChoice,
  env: Record<string, string | undefined>,
): RuntimeDecision {
  if (choice.name === "claude") {
    if (!hasNonEmpty(env.ANTHROPIC_API_KEY)) {
      return { kind: "skipped", reason: "ANTHROPIC_API_KEY not set" };
    }
    return { kind: "ready", runtime: createClaudeAgentsRuntime() };
  }
  if (choice.name === "openai") {
    if (!hasNonEmpty(env.OPENAI_API_KEY)) {
      return { kind: "skipped", reason: "OPENAI_API_KEY not set" };
    }
    return { kind: "ready", runtime: createOpenAIAgentsRuntime() };
  }
  if (!hasNonEmpty(env.OPENAI_API_KEY)) {
    return { kind: "skipped", reason: "OPENAI_API_KEY not set (Codex CLI uses it for auth)" };
  }
  return { kind: "ready", runtime: createMonoRuntime() };
}

function hasNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function _typecheck(_provider: A2AProviderStartResult): void {
  // touch import to keep tsc happy across @mono-agent/a2a-adapter types
}
void _typecheck;
