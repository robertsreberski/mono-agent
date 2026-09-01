import { useCallback, useMemo } from "react";
import { useConsoleStore } from "../console-store";
import { conversationConsoleUsage, type ConsoleUsage } from "../usage";
import {
  buildSelectorModels,
  providerOfModel,
  type ModelSelectorOption,
} from "./model-catalog";

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
    catalogByProvider,
    ensureProviderCatalog,
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
    const catalogModels = Object.fromEntries(
      Object.entries(catalogByProvider ?? {}).map(([provider, state]) => [provider, state.models]),
    );
    return buildSelectorModels({
      agent: selectedAgent,
      modelOptions,
      defaultEffort: agentDefaultEffort || selectedAgent?.defaultEffort || "",
      catalogByProvider: catalogModels,
    });
  }, [agentDefaultEffort, catalogByProvider, modelOptions, selectedAgent]);

  const catalogStatusByProvider = useMemo(
    () => Object.fromEntries(
      Object.entries(catalogByProvider ?? {}).map(([provider, state]) => [provider, state.status]),
    ),
    [catalogByProvider],
  );

  // The selector calls these when it opens (preload the shortlist routes) and
  // when a provider chip is requested directly; the store fetches once per
  // (agent, provider) with an in-flight guard.
  const openCatalog = useCallback(() => {
    const providers = new Set(modelOptions.map((reference) => providerOfModel(reference)));
    for (const provider of providers) void ensureProviderCatalog(provider);
  }, [ensureProviderCatalog, modelOptions]);

  const requestProvider = useCallback(
    (provider: string) => {
      void ensureProviderCatalog(provider);
    },
    [ensureProviderCatalog],
  );

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
    catalogStatusByProvider,
    openCatalog,
    requestProvider,
    // A running turn owns its model; changing it mid-flight would describe a
    // request the agent never received.
    disabled: selectedThread?.runState.status === "running",
    hasSettings: modelOptions.length > 0 || effortOptions.length > 0,
  };
}