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
  // A blank selector displays the field's actual inheritance target. For a new
  // draft that can be the web-owned agent default; an explicit blank or an
  // existing thread resolves back to the agent's configured default.
  const agentDefaultModel = model === "" ? effectiveModel : selectedAgent?.defaultModel ?? "";
  const agentDefaultEffort = effort === "" ? effectiveEffort : selectedAgent?.defaultEffort ?? "";

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
      agent: selectedAgent === null
        ? null
        : { ...selectedAgent, ...(agentDefaultModel === "" ? {} : { defaultModel: agentDefaultModel }) },
      modelOptions,
      defaultEffort: agentDefaultEffort || selectedAgent?.defaultEffort || "",
      catalogByProvider: catalogModels,
      selectedModel: model,
    });
  }, [agentDefaultEffort, agentDefaultModel, catalogByProvider, model, modelOptions, selectedAgent]);

  const catalogStatusByProvider = useMemo(
    () => Object.fromEntries(
      Object.entries(catalogByProvider ?? {}).map(([provider, state]) => [provider, state.status]),
    ),
    [catalogByProvider],
  );

  // The selector calls these when it opens (preload the shortlist routes) and
  // when a provider chip is requested directly; the store fetches once per
  // (agent, provider) with an in-flight guard.
  const agentProviders = selectedAgent?.providers ?? [];
  const openCatalog = useCallback(() => {
    // Shortlist routes first so the default groups render immediately, then the
    // agent's declared providers -- a provider listed purely to widen selection
    // appears in neither `modelOptions` nor any group until it is fetched.
    const providers = new Set(modelOptions.map((reference) => providerOfModel(reference)));
    for (const provider of agentProviders) providers.add(provider.id);
    for (const provider of providers) void ensureProviderCatalog(provider);
  }, [agentProviders, ensureProviderCatalog, modelOptions]);

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
    agentProviders,
    // A running turn owns its model; changing it mid-flight would describe a
    // request the agent never received.
    disabled: selectedThread?.runState.status === "running",
    hasSettings: modelOptions.length > 0 || effortOptions.length > 0,
  };
}
