import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Command } from "cmdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../Icon";
import type { AgentProvider } from "../../types";
import {
  groupSelectorModels,
  selectorProvides,
  type ModelSelectorOption,
} from "../model-catalog";

export type { ModelSelectorEffortOption, ModelSelectorOption } from "../model-catalog";

export type ProviderCatalogStatus = "loading" | "loaded" | "error";

export type ModelSelectorProps = {
  readonly models: readonly ModelSelectorOption[];
  readonly value: string;
  readonly effort: string;
  readonly onValueChange: (value: string) => void;
  readonly onEffortChange: (effort: string) => void;
  readonly disabled?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly badge?: "custom" | "default";
  /** Marks the row this agent starts new conversations on. */
  readonly agentDefaultId?: string;
  /** Offered only while a conversation override is in force. */
  readonly onReset?: () => void;
  /** Asks the caller to fetch a provider's catalog lazily (chips and open). */
  readonly onProviderRequest?: (provider: string) => void;
  /** Providers the agent advertises, so a declared-but-unfetched one still gets a chip. */
  readonly agentProviders?: readonly AgentProvider[];
  /** Fetch state per provider, used to tell "still loading" from "no match". */
  readonly providerStatus?: Readonly<Record<string, ProviderCatalogStatus>>;
};

/**
 * The automatic row is always reachable; empty means "let the agent pick".
 * Real rows key off their model id so filtering and grouping never invalidate
 * the value cmdk highlights.
 */
const commandValue = (model: ModelSelectorOption) =>
  model.id === "" ? "model::automatic" : `model:${model.id}`;

/**
 * Controlled model and reasoning-effort picker adapted from assistant-ui's
 * Base UI model-selector registry component. The data-slot names intentionally
 * follow the upstream registry so styling and future source comparisons remain
 * straightforward.
 *
 * Source: https://r.assistant-ui.com/base/model-selector.json
 */
export function ModelSelector({
  models,
  value,
  effort,
  onValueChange,
  onEffortChange,
  disabled = false,
  open: controlledOpen,
  onOpenChange,
  badge,
  agentDefaultId,
  onReset,
  onProviderRequest,
  providerStatus,
  agentProviders,
}: ModelSelectorProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (controlledOpen === undefined) setInternalOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [controlledOpen, onOpenChange],
  );
  const selectedModel = useMemo(
    () => models.find((model) => model.id === value) ?? models[0],
    [models, value],
  );
  const activeEffort = selectedModel?.efforts.find((option) => option.id === effort);
  const selectedCommandValue = selectedModel ? commandValue(selectedModel) : undefined;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    if (!open) {
      setQuery("");
      setActiveProvider(null);
      return;
    }
    searchRef.current?.focus();
  }, [disabled, open, setOpen]);

  const selectModel = (model: ModelSelectorOption) => {
    onValueChange(model.id);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const normalizeQuery = (value: string) =>
    value.replace(/[A-Z]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 32),
    );
  const matchesQuery = (model: ModelSelectorOption, search: string) =>
    [model.id, model.name, model.description]
      .some((part) => part !== undefined && normalizeQuery(part).includes(search));

  const filteredModels = useMemo(() => {
    const byProvider = activeProvider === null
      ? models
      : models.filter((model) => !model.provider || model.provider === activeProvider);
    const search = normalizeQuery(query.trim());
    return search.length === 0 ? byProvider : byProvider.filter((model) => matchesQuery(model, search));
  }, [activeProvider, models, query]);

  const groups = useMemo(() => groupSelectorModels(filteredModels), [filteredModels]);
  const provides = useMemo(() => selectorProvides(groups, agentProviders), [agentProviders, groups]);

  const emptyMessage = query.trim().length === 0
    ? activeProvider !== null && (
        providerStatus?.[activeProvider] === "loading" ||
        providerStatus?.[activeProvider] === undefined
      )
      ? "Loading models…"
      : "No models found."
    : "No models match.";

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        ref={triggerRef}
        data-slot="model-selector-trigger"
        className="model-selector__trigger"
        aria-label="Model and reasoning effort"
        aria-haspopup="dialog"
        disabled={disabled}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span data-slot="model-selector-value" className="model-selector__value">
          <span className="model-selector__model-name">
            {selectedModel?.name ?? "Select model"}
          </span>
          {activeEffort && (
            <span className="model-selector__effort-value">{activeEffort.name}</span>
          )}
          {badge !== undefined && <span className={`model-selector__badge is-${badge}`}>{badge}</span>}
        </span>
        <Icon name="arrow-down" size={14} />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Backdrop
          data-slot="model-selector-backdrop"
          className="model-selector__backdrop"
        />
        <Popover.Positioner
          data-slot="model-selector-positioner"
          className="model-selector__positioner"
          align="start"
          side="bottom"
          sideOffset={6}
        >
          <Popover.Popup
            data-slot="model-selector-content"
            className="model-selector__content"
            aria-label="Model and reasoning effort"
          >
            <Command
              data-slot="model-selector-command"
              className="model-selector__command"
              label="Search models"
              loop
              shouldFilter={false}
              {...(selectedCommandValue ? { defaultValue: selectedCommandValue } : {})}
            >
              <div
                data-slot="model-selector-search-wrapper"
                className="model-selector__search-wrapper"
              >
                <Icon name="search" size={15} />
                <Command.Input
                  ref={searchRef}
                  data-slot="model-selector-search"
                  className="model-selector__search"
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search models…"
                  aria-label="Search models"
                />
              </div>

              {provides.length > 1 && (
                <div
                  data-slot="model-selector-providers"
                  className="model-selector__providers"
                  onKeyDown={(event) => {
                    if (event.key === "Home" || event.key === "End") {
                      event.stopPropagation();
                    }
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      searchRef.current?.focus();
                    }
                  }}
                >
                  <RadioGroup
                    className="model-selector__provider-options"
                    value={activeProvider ?? ""}
                    onValueChange={(nextProvider) => {
                      const provider = nextProvider || null;
                      setActiveProvider(provider);
                      if (provider !== null) onProviderRequest?.(provider);
                    }}
                    aria-label="Filter by provider"
                  >
                    <Radio.Root
                      data-slot="model-selector-provider-option"
                      className="model-selector__provider-option"
                      value=""
                    >
                      All
                    </Radio.Root>
                    {provides.map(({ provider, label }) => (
                      <Radio.Root
                        key={provider}
                        data-slot="model-selector-provider-option"
                        className="model-selector__provider-option"
                        value={provider}
                      >
                        {label}
                      </Radio.Root>
                    ))}
                  </RadioGroup>
                </div>
              )}

              <Command.List
                data-slot="model-selector-list"
                className="model-selector__list"
              >
                <Command.Empty
                  data-slot="model-selector-empty"
                  className="model-selector__empty"
                >
                  {emptyMessage}
                </Command.Empty>
                <Command.Group
                  data-slot="model-selector-group"
                  className="model-selector__group"
                >
                  {filteredModels.filter((model) => !model.provider).map((model) => {
                    const selected = model.id === value;
                    return (
                      <Command.Item
                        key={`${commandValue(model)}:${model.name}`}
                        data-slot="model-selector-item"
                        data-model-selected={selected || undefined}
                        className="model-selector__item"
                        value={commandValue(model)}
                        keywords={[
                          model.id,
                          model.name,
                          ...(model.description ? [model.description] : []),
                        ]}
                        onSelect={() => selectModel(model)}
                      >
                        <span className="model-selector__item-copy">
                          <span className="model-selector__item-name">{model.name}</span>
                          {model.description && (
                            <span className="model-selector__item-description">
                              {model.description}
                            </span>
                          )}
                        </span>
                        {model.id !== "" && model.id === agentDefaultId && (
                          <span className="model-selector__item-default">agent default</span>
                        )}
                        {selected && (
                          <span
                            data-slot="model-selector-selected-indicator"
                            className="model-selector__selected-indicator"
                            aria-hidden="true"
                          >
                            <Icon name="check" size={15} />
                          </span>
                        )}
                      </Command.Item>
                    );
                  })}
                </Command.Group>
                {groups.map((group) => (
                  <Command.Group
                    key={group.provider}
                    heading={group.label}
                    data-slot="model-selector-group"
                    className="model-selector__group"
                  >
                    {group.models.map((model) => {
                      const selected = model.id === value;
                      return (
                        <Command.Item
                          key={`${commandValue(model)}:${model.name}`}
                          data-slot="model-selector-item"
                          data-model-selected={selected || undefined}
                          className="model-selector__item"
                          value={commandValue(model)}
                          keywords={[
                            model.id,
                            model.name,
                            ...(model.description ? [model.description] : []),
                          ]}
                          onSelect={() => selectModel(model)}
                        >
                          <span className="model-selector__item-copy">
                            <span className="model-selector__item-name">{model.name}</span>
                            {model.description && (
                              <span className="model-selector__item-description">
                                {model.description}
                              </span>
                            )}
                          </span>
                          {model.id !== "" && model.id === agentDefaultId && (
                            <span className="model-selector__item-default">agent default</span>
                          )}
                          {selected && (
                            <span
                              data-slot="model-selector-selected-indicator"
                              className="model-selector__selected-indicator"
                              aria-hidden="true"
                            >
                              <Icon name="check" size={15} />
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
              </Command.List>

              {(selectedModel?.efforts.length ?? 0) > 0 && (
                <div
                  data-slot="model-selector-effort"
                  className="model-selector__effort"
                  onKeyDown={(event) => {
                    if (event.key === "Home" || event.key === "End") {
                      event.stopPropagation();
                    }
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      searchRef.current?.focus();
                    }
                  }}
                >
                  <span className="model-selector__effort-label">Thinking</span>
                  <RadioGroup
                    className="model-selector__effort-options"
                    value={activeEffort?.id ?? ""}
                    onValueChange={(nextEffort) => onEffortChange(nextEffort)}
                    aria-label="Reasoning effort"
                  >
                    {selectedModel?.efforts.map((option) => (
                      <Radio.Root
                        key={`${option.id}:${option.name}`}
                        data-slot="model-selector-effort-option"
                        className="model-selector__effort-option"
                        value={option.id}
                      >
                        {option.name}
                      </Radio.Root>
                    ))}
                  </RadioGroup>
                </div>
              )}

              {onReset !== undefined && (
                <div className="model-selector__reset">
                  <button
                    type="button"
                    onClick={() => {
                      onReset();
                      setOpen(false);
                    }}
                  >
                    <Icon name="restore" size={13} />
                    Reset to agent default
                  </button>
                </div>
              )}
            </Command>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}