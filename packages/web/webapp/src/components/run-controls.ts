import { useMemo } from "react";
import { effortLevelsForAgentModel, useConsoleStore } from "../console-store";
import { conversationConsoleUsage, type ConsoleUsage } from "../usage";
import type {
  ModelSelectorEffortOption,
  ModelSelectorOption,
} from "./assistant-ui/ModelSelector";

export const effortName = (effort: string): string => ({
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
}[effort] ?? effort);

export const defaultEffortName = (effort: string | undefined, toggle: boolean): string => {
  if (effort === undefined) return "Provider";
  if (toggle) return effort === "none" ? "Off" : "On";
  return effortName(effort);
};

/**
 * The model and context derivations, owned by neither surface that shows them.
 * The desktop renders a popover in the chat header and the phone renders bottom
 * sheets from the conversation sheet; both need the same resolved model list and
 * the same context projection, and the phone's copy used to not exist at all.
 */
export function useRunControls() {
  const {
    model,
    effort,
    modelOptions,
    effortOptions,
    setModel,
    setEffort,
    selectedThread,
    selectedAgent,
    detail,
    effectiveModel,
    effectiveEffort,
    hasRunOverride,
    resetRunOverride,
  } = useConsoleStore();
  // The agent's own advertised defaults. Console-owned per-agent run defaults are
  // a separate feature with its own server contract; until that exists, "the
  // agent default" is exactly what the agent advertises.
  const agentDefaultModel = selectedAgent?.defaultModel ?? "";
  const agentDefaultEffort = selectedAgent?.defaultEffort ?? "";

  const usage = useMemo<ConsoleUsage | null>(() => {
    const projected = conversationConsoleUsage(detail, { selectedModel: effectiveModel });
    if (projected !== null) return projected;
    if (selectedThread === null) return null;
    return {
      context: selectedThread.runState.status === "running"
        ? {
            status: "updating",
            reason: "The conversation is loading while the current turn updates context.",
          }
        : {
            status: "unavailable",
            reason: "Context measurements are loading for this conversation.",
          },
    };
  }, [detail, effectiveModel, selectedThread]);

  const selectorModels = useMemo<readonly ModelSelectorOption[]>(() => {
    if (!selectedAgent) return [];
    const effortChoices = (reference: string): readonly ModelSelectorEffortOption[] => {
      const effectiveReference = reference || agentDefaultModel || selectedAgent.defaultModel || modelOptions[0] || "";
      const toggle = selectedAgent.modelOptions?.[effectiveReference]?.reasoningMode === "toggle";
      const levels = effortLevelsForAgentModel(selectedAgent, effectiveReference);
      if (levels.length === 0) return [];
      return [
        { id: "", name: `Default · ${defaultEffortName(agentDefaultEffort || selectedAgent.defaultEffort, toggle)}` },
        ...levels.map((level) => ({
          id: level,
          name: toggle
            ? level === "none" ? "Off" : "On"
            : effortName(level),
        })),
      ];
    };
    return [
      {
        id: "",
        name: `Default · ${(selectedAgent.modelOptions?.[agentDefaultModel]?.label ?? agentDefaultModel) || "agent"}`,
        description: agentDefaultModel
          ? `Agent default · ${agentDefaultModel}`
          : "Use the agent default",
        efforts: effortChoices(""),
      },
      ...modelOptions.map((reference) => ({
        id: reference,
        name: selectedAgent.modelOptions?.[reference]?.label ?? reference,
        description: reference,
        efforts: effortChoices(reference),
      })),
    ];
  }, [agentDefaultEffort, agentDefaultModel, modelOptions, selectedAgent]);

  return {
    usage,
    selectorModels,
    model,
    effort,
    effectiveModel,
    effectiveEffort,
    setModel,
    setEffort,
    agentDefaultModel,
    hasRunOverride,
    resetRunOverride,
    // A running turn owns its model; changing it mid-flight would describe a
    // request the agent never received.
    disabled: selectedThread?.runState.status === "running",
    hasSettings: modelOptions.length > 0 || effortOptions.length > 0,
  };
}
