

import type { RedactedMemoryConfig } from "../types.js";

import type { BuildMonoAgentConfigViewInput, ConfigViewField, ConfigViewSection } from "./types.js";

import { PLACEHOLDER, toField } from "./fields.js";

export function buildMemorySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const memory: RedactedMemoryConfig | undefined = redacted.memory;
  if (memory === undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "disabled",
      fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }

  const fields: ConfigViewField[] = [
    toField({
      id: "memory.backend",
      label: "Backend",
      value: memory.backend ?? "bujo",
      jsonPresent: json.memory?.backend !== undefined,
    }),
    toField({
      id: "memory.mode",
      label: "Mode",
      value: memory.mode,
      jsonPresent: json.memory?.mode !== undefined,
    }),
    toField({
      id: "memory.path",
      label: "Path",
      value: memory.path,
      jsonPresent: json.memory?.path !== undefined,
    }),
    toField({
      id: "memory.maxBytes",
      label: "Max bytes",
      value: String(memory.maxBytes),
      jsonPresent: json.memory?.maxBytes !== undefined,
    }),
    toField({
      id: "memory.writeMode",
      label: "Write mode",
      value: memory.writeMode,
      jsonPresent: json.memory?.writeMode !== undefined,
    }),
    toField({ id: "memory.profile.enabled", label: "Owner profile",
      value: memory.profile?.enabled === true ? "on" : "off", jsonPresent: json.memory?.profile !== undefined }),
    ...([ ["intentExpiry", "Exclude dated/closed intention notes"], ["recency", "Deliberate transient recency"] ] as const).map(([key, label]) => toField({
      id: `memory.recall.${key}`, label, value: memory.recall?.[key] === true ? "on" : "off", jsonPresent: json.memory?.recall?.[key] !== undefined,
    })),
    toField({ id: "memory.capture.intentLifecycle", label: "Capture supported intentions",
      value: memory.capture?.intentLifecycle === true ? "on" : "off", jsonPresent: json.memory?.capture?.intentLifecycle !== undefined }),
    ...(memory.capture?.cron === undefined ? [] : [toField({
      id: "memory.capture.cron",
      label: "Capture cron",
      value: String(memory.capture.cron),
      jsonPresent: json.memory?.capture?.cron !== undefined,
    })]),
    ...(memory.capture?.webhook === undefined ? [] : [toField({
      id: "memory.capture.webhook",
      label: "Capture webhook",
      value: String(memory.capture.webhook),
      jsonPresent: json.memory?.capture?.webhook !== undefined,
    })]),
    ...(memory.capture?.focus === undefined ? [] : [toField({
      id: "memory.capture.focus",
      label: "Capture focus",
      value: memory.capture.focus,
      jsonPresent: json.memory?.capture?.focus !== undefined,
    })]),
    ...(memory.capture?.only === undefined ? [] : [toField({
      id: "memory.capture.only",
      label: "Capture only",
      value: JSON.stringify(memory.capture.only),
      jsonPresent: json.memory?.capture?.only !== undefined,
    })]),
    ...(memory.capture?.reconcileModel === undefined ? [] : [toField({
      id: "memory.capture.reconcileModel",
      label: "Reconcile model",
      value: memory.capture.reconcileModel,
      jsonPresent: json.memory?.capture?.reconcileModel !== undefined,
    })]),
    toField({
      id: "memory.recallTool.enabled",
      label: "Recall tool",
      value: memory.recallTool === undefined ? "default" : memory.recallTool.enabled ? "on" : "off",
      jsonPresent: json.memory?.recallTool?.enabled !== undefined,
    }),
    toField({
      id: "memory.rememberTool.enabled",
      label: "Remember tool",
      value: memory.rememberTool === undefined ? "default" : memory.rememberTool.enabled ? "on" : "off",
      jsonPresent: json.memory?.rememberTool?.enabled !== undefined,
    }),
  ];

  const embeddings = memory.embeddings;
  if (embeddings !== undefined) {
    fields.push(
      toField({
        id: "memory.embeddings.provider",
        label: "Embeddings provider",
        value: embeddings.provider,
        jsonPresent: json.memory?.embeddings?.provider !== undefined,
      }),
      toField({
        id: "memory.embeddings.model",
        label: "Embeddings model",
        value: embeddings.model,
        jsonPresent: json.memory?.embeddings?.model !== undefined,
      }),
      toField({
        id: "memory.embeddings.endpoint",
        label: "Embeddings endpoint",
        value: embeddings.endpoint ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.endpoint !== undefined,
      }),
      toField({
        id: "memory.embeddings.apiKey",
        label: "Embeddings API key",
        value: embeddings.apiKey?.present === true ? "set" : "unset",
        jsonPresent: json.memory?.embeddings?.apiKey !== undefined,
        redacted: true,
      }),
      toField({
        id: "memory.embeddings.apiKeyEnv",
        label: "Embeddings API key env",
        value: embeddings.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "memory.embeddings.dim",
        label: "Embeddings dimension",
        value: embeddings.dim === undefined ? "default" : String(embeddings.dim),
        jsonPresent: json.memory?.embeddings?.dim !== undefined,
      }),
      toField({
        id: "memory.embeddings.timeoutMs",
        label: "Embeddings timeout (ms)",
        value: embeddings.timeoutMs === undefined ? "default" : String(embeddings.timeoutMs),
        jsonPresent: json.memory?.embeddings?.timeoutMs !== undefined,
      }),
      toField({
        id: "memory.embeddings.instructions",
        label: "Embeddings instructions",
        value: embeddings.instructions ?? "auto",
        jsonPresent: json.memory?.embeddings?.instructions !== undefined,
      }),
      toField({
        id: "memory.embeddings.circuitBreaker.failureThreshold",
        label: "Embeddings breaker threshold",
        value: embeddings.circuitBreaker?.failureThreshold === undefined ? "default" : String(embeddings.circuitBreaker.failureThreshold),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.failureThreshold !== undefined,
      }),
      toField({
        id: "memory.embeddings.circuitBreaker.cooldownMs",
        label: "Embeddings breaker cooldown (ms)",
        value: embeddings.circuitBreaker?.cooldownMs === undefined ? "default" : String(embeddings.circuitBreaker.cooldownMs),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.cooldownMs !== undefined,
      }),
    );
  }

  const llm = memory.llm;
  if (llm !== undefined) {
    fields.push(
      toField({
        id: "memory.llm.provider",
        label: "LLM provider",
        value: llm.provider,
        jsonPresent: json.memory?.llm?.provider !== undefined,
      }),
      toField({
        id: "memory.llm.model",
        label: "LLM model",
        value: llm.model,
        jsonPresent: json.memory?.llm?.model !== undefined,
      }),
    );
    if (llm.provider === "ollama") {
      fields.push(
        toField({
          id: "memory.llm.endpoint",
          label: "LLM endpoint",
          value: llm.endpoint ?? PLACEHOLDER,
          jsonPresent: json.memory?.llm?.endpoint !== undefined,
        }),
      );
    } else {
      fields.push(
        toField({
          id: "memory.llm.trace",
          label: "LLM trace",
          value: llm.trace === false ? "off" : "on",
          jsonPresent: json.memory?.llm?.trace !== undefined,
        }),
        toField({
          id: "memory.llm.timeoutMs",
          label: "LLM timeout (ms)",
          value: llm.timeoutMs === undefined ? "default" : String(llm.timeoutMs),
          jsonPresent: json.memory?.llm?.timeoutMs !== undefined,
        }),
      );
    }
  }

  if (memory.mode === "bujo" || memory.consolidation !== undefined) {
    fields.push(
      toField({
        id: "memory.consolidation.enabled",
        label: "Consolidation",
        value: memory.consolidation?.enabled === false ? "off" : "on",
        jsonPresent: json.memory?.consolidation?.enabled !== undefined,
      }),
      toField({
        id: "memory.consolidation.cron",
        label: "Consolidation cron",
        value: memory.consolidation?.cron ?? "default (0 */2 * * *)",
        jsonPresent: json.memory?.consolidation?.cron !== undefined,
      }),
    );
  }

  return { id: "memory", label: "Memory", status: "active", fields };
}
