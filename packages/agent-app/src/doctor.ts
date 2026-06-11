import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describeMonoRuntimeSupport } from "@mono-agent/runtime-adapter";
import type { MonoAgentConfig } from "@mono-agent/config";

import { isAppCoreConfigError, loadAppCoreConfig } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import { defaultChannelDrivers } from "./channels.js";
import type { ChannelDriver } from "./channels.js";

export type ValidationStatus = "ok" | "waiting" | "disabled" | "error";

export interface ValidationSection {
  readonly id: string;
  readonly label: string;
  readonly status: ValidationStatus;
  readonly details: readonly string[];
}

export interface ValidationReport {
  readonly sections: readonly ValidationSection[];
  /** True when no section reports an error. Waiting/disabled channels are fine. */
  readonly ok: boolean;
}

export interface ValidateMonoAgentFolderOptions extends MonoAgentAppConfigInput {
  readonly drivers?: readonly ChannelDriver[];
}

/**
 * Loads every config section the app would use at start and reports it
 * per-section, so an engineer can see exactly what would run, wait, or fail —
 * before starting anything.
 */
export async function validateMonoAgentFolder(
  options: ValidateMonoAgentFolderOptions,
): Promise<ValidationReport> {
  const sections: ValidationSection[] = [];
  const drivers = options.drivers ?? defaultChannelDrivers();

  let coreConfig: MonoAgentConfig | undefined;
  try {
    coreConfig = await loadAppCoreConfig(options);
    sections.push({ id: "core", label: "Core config", status: "ok", details: [`Loaded ${options.configPath}.`] });
  } catch (error) {
    if (!isAppCoreConfigError(error)) {
      throw error;
    }
    sections.push({ id: "core", label: "Core config", status: "error", details: [error.message] });
  }

  if (coreConfig !== undefined) {
    sections.push(runtimeSection(coreConfig));
    sections.push(await contextSection(coreConfig));
    sections.push(memorySection(coreConfig));
    sections.push(await toolsSection(coreConfig));
    sections.push(sandboxSection(coreConfig));
  }

  for (const driver of drivers) {
    sections.push(await channelSection(driver, options));
  }

  return {
    sections,
    ok: sections.every((section) => section.status !== "error"),
  };
}

function runtimeSection(config: MonoAgentConfig): ValidationSection {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  const primary = describeMonoRuntimeSupport(config.runtime.model, config.runtime.executionMode);
  if (primary.compatible) {
    details.push(`Primary model ${referenceOf(config.runtime.model)} runs on ${primary.backend?.label ?? "unknown backend"} (${config.runtime.executionMode}).`);
  } else {
    status = "error";
    details.push(`Primary model ${referenceOf(config.runtime.model)}: ${primary.incompatibilityReason ?? "unsupported"}.`);
  }

  for (const fallback of config.runtime.fallbackModels ?? []) {
    const support = describeMonoRuntimeSupport(fallback);
    if (support.compatible) {
      details.push(`Fallback model ${referenceOf(fallback)} runs on ${support.backend?.label ?? "unknown backend"}.`);
    } else {
      status = "error";
      details.push(`Fallback model ${referenceOf(fallback)}: ${support.incompatibilityReason ?? "unsupported"}.`);
    }
  }

  return { id: "runtime", label: "Runtime", status, details };
}

async function contextSection(config: MonoAgentConfig): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  if (await pathExists(config.context.identityPath)) {
    details.push(`Identity: ${config.context.identityPath}`);
  } else {
    status = "error";
    details.push(`Identity file is missing: ${config.context.identityPath}`);
  }

  if (config.context.soulPath !== undefined && !(await pathExists(config.context.soulPath))) {
    status = "error";
    details.push(`Soul file is missing: ${config.context.soulPath}`);
  }

  if (config.context.skillsRoot !== undefined) {
    if (await pathExists(config.context.skillsRoot)) {
      details.push(`Skills root: ${config.context.skillsRoot}`);
      for (const skill of config.context.selectedSkills) {
        const skillPath = join(config.context.skillsRoot, skill, "SKILL.md");
        if (await pathExists(skillPath)) {
          details.push(`Skill \`${skill}\`: ${skillPath}`);
        } else {
          status = "error";
          details.push(`Skill \`${skill}\` is selected but ${skillPath} is missing.`);
        }
      }
    } else {
      status = "error";
      details.push(`Skills root is missing: ${config.context.skillsRoot}`);
    }
  } else if (config.context.selectedSkills.length > 0) {
    status = "error";
    details.push("Skills are selected but context.skillsRoot is not set.");
  }

  return { id: "context", label: "Context & skills", status, details };
}

function memorySection(config: MonoAgentConfig): ValidationSection {
  if (config.memory === undefined) {
    return { id: "memory", label: "Memory", status: "disabled", details: ["No memory configured."] };
  }
  const details = [
    `Mode: ${config.memory.mode}, path: ${config.memory.path}, writeMode: ${config.memory.writeMode}.`,
  ];
  if (config.memory.tools?.enabled === true) {
    details.push(`Memory MCP tools enabled${config.memory.tools.allowJournalAppend ? " (journal append allowed)" : ""}.`);
  }
  return { id: "memory", label: "Memory", status: "ok", details };
}

async function toolsSection(config: MonoAgentConfig): Promise<ValidationSection> {
  const details: string[] = [];
  let status: ValidationStatus = "ok";

  details.push(
    config.tools.allowedTools.length === 0
      ? "No tools allowed (fail-closed default)."
      : `Allowed tools: ${config.tools.allowedTools.join(", ")}.`,
  );
  if (config.tools.disallowedTools.length > 0) {
    details.push(`Disallowed tools: ${config.tools.disallowedTools.join(", ")}.`);
  }
  if (config.tools.mcpConfigPath !== undefined) {
    if (await pathExists(config.tools.mcpConfigPath)) {
      details.push(`MCP config: ${config.tools.mcpConfigPath}`);
    } else {
      status = "error";
      details.push(`MCP config file is missing: ${config.tools.mcpConfigPath}`);
    }
  }

  return { id: "tools", label: "Tools & MCP", status, details };
}

function sandboxSection(config: MonoAgentConfig): ValidationSection {
  if (config.sandbox === undefined) {
    return { id: "sandbox", label: "Sandbox", status: "disabled", details: ["No sandbox policy configured."] };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    status: "ok",
    details: [
      `Mode: ${config.sandbox.mode}, network: ${config.sandbox.network.mode}, fallback: ${config.sandbox.fallback}.`,
    ],
  };
}

async function channelSection(
  driver: ChannelDriver,
  input: MonoAgentAppConfigInput,
): Promise<ValidationSection> {
  const id = `channel:${driver.id}`;
  try {
    const config = await driver.loadConfig(input);
    const disabledReason = driver.disabledReason?.(config);
    if (disabledReason !== undefined) {
      return { id, label: driver.label, status: "disabled", details: [disabledReason] };
    }
    const waitingReason = driver.waitingReason?.(config);
    if (waitingReason !== undefined) {
      return { id, label: driver.label, status: "waiting", details: [waitingReason] };
    }
    return { id, label: driver.label, status: "ok", details: ["Configured; will start with the app."] };
  } catch (error) {
    if (driver.isConfigError(error)) {
      const reason = error instanceof Error ? error.message : String(error);
      return { id, label: driver.label, status: "waiting", details: [reason] };
    }
    throw error;
  }
}

function referenceOf(model: MonoAgentConfig["runtime"]["model"]): string {
  return model.reference ?? `${model.sdk}:${model.provider === undefined ? "" : `${model.provider}:`}${model.model}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
