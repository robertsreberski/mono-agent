import { Dialog } from "@base-ui/react/dialog";
import {
  ComposerPrimitive,
  unstable_defaultDirectiveFormatter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_TriggerItem,
} from "@assistant-ui/react";
import { Command } from "cmdk";
import { useEffect, useMemo, useRef, useState } from "react";

import { isUsableSkill, rankSkills } from "../../skill-discovery";
import type { SkillInfo, SkillRegistryState } from "../../types";
import { Icon } from "../Icon";

export interface SkillAutocompleteProps {
  readonly skills: readonly SkillInfo[];
  readonly query: string;
  readonly cursor: number;
  readonly onSelect: (name: string) => void;
}

export interface SkillBrowserProps {
  readonly agentLabel: string | undefined;
  readonly registry: SkillRegistryState;
  readonly onBeforeOpen: () => void;
  readonly onSelect: (name: string) => void;
}

const statusLabel = (skill: SkillInfo): string => {
  if (skill.availability === "inlined") return "In prompt";
  if (skill.availability === "on-demand") return "On demand";
  if (skill.unavailableReason === "read-skill-disabled") return "ReadSkill disabled";
  if (skill.unavailableReason === "unsupported-name") return "Unsupported name";
  return "Not selected";
};

const skillFormatter = {
  ...unstable_defaultDirectiveFormatter,
  serialize: (item: Unstable_TriggerItem) => `$${item.id}`,
};

function SkillPopoverBridge({
  cursor,
  resultCount,
  onSelect,
}: {
  readonly cursor: number;
  readonly resultCount: number;
  readonly onSelect: (name: string) => void;
}) {
  const popover = unstable_useTriggerPopoverScopeContext();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => popover.setCursorPosition(cursor));
    return () => window.cancelAnimationFrame(frame);
  }, [cursor, popover.setCursorPosition]);

  useEffect(() => popover.registerSelectItemOverride((item) => {
    onSelectRef.current(item.id);
    // App-owned insertion revalidates the current agent registry and restores
    // the DOM caret. Prevent the upstream action from mutating text a second time.
    return true;
  }), [popover.registerSelectItemOverride]);

  return popover.open ? (
    <span className="sr-only" role="status" aria-live="polite">
      {resultCount} skill suggestion{resultCount === 1 ? "" : "s"} available.
    </span>
  ) : null;
}

export function SkillAutocomplete({ skills, query, cursor, onSelect }: SkillAutocompleteProps) {
  const adapter = useMemo(() => ({
    categories: () => [],
    categoryItems: () => [],
    search: (nextQuery: string): readonly Unstable_TriggerItem[] =>
      rankSkills(skills, nextQuery).map((skill) => ({
        id: skill.name,
        type: "skill",
        label: skill.reference ?? `$${skill.name}`,
        description: skill.description,
        metadata: { availability: skill.availability },
      })),
  }), [skills]);
  const resultCount = rankSkills(skills, query).length;

  return (
    <ComposerPrimitive.Unstable_TriggerPopover
      char="$"
      adapter={adapter}
      aria-label="Skills"
      data-slot="skill-autocomplete"
      className="composer-trigger-popover skill-autocomplete"
    >
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        formatter={skillFormatter}
        onExecute={() => undefined}
      />
      <SkillPopoverBridge cursor={cursor} resultCount={resultCount} onSelect={onSelect} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems aria-label="Available skills">
        {(items) => (
          <div className="composer-trigger-list" data-slot="skill-autocomplete-list">
            {items.map((item, index) => {
              const skill = skills.find((candidate) => candidate.name === item.id);
              if (skill === undefined) return null;
              return (
                <ComposerPrimitive.Unstable_TriggerPopoverItem
                  key={item.id}
                  item={item}
                  index={index}
                  className="composer-trigger-item skill-result"
                  data-slot="skill-autocomplete-item"
                >
                  <span className="composer-trigger-item-icon"><Icon name="spark" size={16} /></span>
                  <span className="composer-trigger-item-copy">
                    <strong>{skill.reference}</strong>
                    <small>{skill.description}</small>
                  </span>
                  <span className="skill-status" data-availability={skill.availability}>
                    {statusLabel(skill)}
                  </span>
                </ComposerPrimitive.Unstable_TriggerPopoverItem>
              );
            })}
          </div>
        )}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  );
}

export function SkillBrowser({
  agentLabel,
  registry,
  onBeforeOpen,
  onSelect,
}: SkillBrowserProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => rankSkills(registry.items, query, {
    includeUnavailable: true,
    limit: 256,
  }), [query, registry.items]);
  const canInsert = registry.status === "ready";

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        type="button"
        className="icon-button composer-tool"
        aria-label="Browse skills"
        title="Browse skills"
        disabled={agentLabel === undefined}
        onClick={onBeforeOpen}
      >
        <Icon name="spark" size={17} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="skill-browser-backdrop" />
        <Dialog.Popup className="skill-browser-popup">
          <header className="skill-browser-header">
            <span>
              <Dialog.Title>Skills</Dialog.Title>
              <Dialog.Description>
                Browse skills for {agentLabel ?? "the active agent"}. Selecting one only inserts its reference.
              </Dialog.Description>
            </span>
            <Dialog.Close className="icon-button" aria-label="Close skills">
              <Icon name="close" size={16} />
            </Dialog.Close>
          </header>
          <Command
            className="skill-browser-command"
            label="Search skills"
            loop
            shouldFilter={false}
          >
            <div className="skill-browser-search">
              <Icon name="search" size={16} />
              <Command.Input
                ref={searchRef}
                value={query}
                onValueChange={setQuery}
                placeholder="Search names and descriptions…"
                aria-label="Search skills"
              />
            </div>
            <SkillRegistryNotice registry={registry} />
            <Command.List className="skill-browser-list" aria-label="Skills">
              {visible.map((skill) => {
                const selectable = canInsert && isUsableSkill(skill);
                return (
                  <Command.Item
                    key={skill.name}
                    value={skill.name}
                    className="skill-browser-item"
                    disabled={!selectable}
                    aria-label={`${skill.reference ?? skill.name}, ${statusLabel(skill)}. ${skill.description}`}
                    onSelect={() => {
                      if (!selectable) return;
                      setOpen(false);
                      onSelect(skill.name);
                    }}
                  >
                    <span className="skill-browser-item-icon"><Icon name="spark" size={16} /></span>
                    <span className="skill-browser-item-copy">
                      <strong>{skill.reference ?? skill.name}</strong>
                      <small>{skill.description}</small>
                    </span>
                    <span className="skill-status" data-availability={skill.availability}>
                      {statusLabel(skill)}
                    </span>
                  </Command.Item>
                );
              })}
              {registry.status === "ready" && visible.length === 0 && (
                <div className="skill-browser-empty" role="status">
                  {registry.items.length === 0 ? "No skills are installed for this agent." : "No matching skills."}
                </div>
              )}
            </Command.List>
          </Command>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SkillRegistryNotice({ registry }: { readonly registry: SkillRegistryState }) {
  let message: string | undefined;
  switch (registry.status) {
    case "loading": message = "Loading skills…"; break;
    case "stale": message = "Showing a stale snapshot. Reconnect before inserting a skill."; break;
    case "error": message = "The agent could not load its skill registry."; break;
    case "unsupported": message = "This agent version does not expose skill discovery."; break;
    case "offline": message = "This agent is offline."; break;
    case "ready":
      message = registry.truncated === true
        ? `Showing ${registry.items.length} of ${registry.total} skills.`
        : undefined;
      break;
  }
  return message === undefined
    ? null
    : <p className="skill-browser-notice" role="status">{message}</p>;
}
