import {
  ComposerPrimitive,
  unstable_useComposerInput,
  useAuiState,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { canUploadInConsole } from "../capabilities";
import { noteComposerDraft, resetComposerDraft } from "../composer-draft";
import { useConsoleStore } from "../console-store";
import {
  detectSkillQuery,
  insertSkillReference,
  isUsableSkill,
  rankSkills,
} from "../skill-discovery";
import { AttachmentErrorListener, ComposerAttachments } from "./Attachments";
import {
  ComposerTriggerPopover,
  type ComposerTriggerCommand,
} from "./assistant-ui/ComposerTriggerPopover";
import { Icon } from "./Icon";
import { ComposerQuotePreview } from "./assistant-ui/Quote";
import { SkillAutocomplete, SkillBrowser } from "./assistant-ui/SkillPicker";

interface BuildComposerCommandsOptions {
  readonly attachmentCount: number;
  readonly hasAgent: boolean;
  readonly hasRunSettings: boolean;
  readonly isRunning: boolean;
  readonly createConversation: () => void;
  readonly openRunSettings: () => void;
  readonly stopResponse: () => void;
}

export const buildComposerCommands = ({
  attachmentCount,
  hasAgent,
  hasRunSettings,
  isRunning,
  createConversation,
  openRunSettings,
  stopResponse,
}: BuildComposerCommandsOptions): readonly ComposerTriggerCommand[] => [
  ...(!isRunning && hasRunSettings
    ? [{
        id: "settings",
        label: "Run settings",
        description: "Choose the model and reasoning effort",
        icon: "settings",
        execute: openRunSettings,
      }]
    : []),
  ...(isRunning
    ? [{
        id: "stop",
        label: "Stop response",
        description: "Cancel the current agent run",
        icon: "stop",
        execute: stopResponse,
      }]
    : []),
  ...(!isRunning && hasAgent && attachmentCount === 0
    ? [{
        id: "new",
        label: "New conversation",
        description: "Start a clean conversation with this agent",
        icon: "new",
        execute: createConversation,
      }]
    : []),
];

export function Composer({ runSettings }: { readonly runSettings?: ReactNode } = {}) {
  const store = useConsoleStore();
  const { connection, selectedAgent, selectedThread } = store;
  const composer = unstable_useComposerInput();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState({ start: composer.value.length, end: composer.value.length });
  const savedBrowseSelection = useRef(selection);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canUpload = !isRunning && canUploadInConsole(connection, selectedAgent, selectedThread);
  const canSend = useAuiState((state) => state.composer.canSend);
  const attachmentCount = useAuiState((state) => state.composer.attachments.length);
  const commands = useMemo(() => buildComposerCommands({
    attachmentCount,
    hasAgent: selectedAgent !== null,
    hasRunSettings: store.modelOptions.length > 0 || store.effortOptions.length > 0,
    isRunning,
    createConversation: () => void store.createThread().catch(() => undefined),
    openRunSettings: () => window.dispatchEvent(new Event("mono-agent:run-settings")),
    stopResponse: () => void store.cancelTurn().catch(() => undefined),
  }), [attachmentCount, isRunning, selectedAgent, store]);
  const statusText =
    selectedAgent?.status === "offline"
      ? `${selectedAgent.label} is offline`
      : selectedThread?.archivedAt
        ? "Conversation archived"
        : undefined;
  const skillQuery = useMemo(
    () => detectSkillQuery(composer.value, selection.start, selection.end),
    [composer.value, selection.end, selection.start],
  );
  const autocompleteSkills = useMemo(
    () => store.skillRegistry.status === "ready" && skillQuery !== null
      ? rankSkills(store.skillRegistry.items, skillQuery.query)
      : [],
    [skillQuery, store.skillRegistry],
  );

  // What the operator has typed or staged and not sent, published where a
  // decision that would DESTROY it can read it -- the automatic service-worker
  // reload above all. Not a hook there: the answer is wanted at the moment of
  // the event, and subscribing would re-render for every keystroke.
  const draftRef = useRef(false);
  useEffect(() => {
    draftRef.current = composer.value.trim().length > 0 || attachmentCount > 0;
    noteComposerDraft(draftRef.current);
  }, [attachmentCount, composer.value]);
  useEffect(() => () => {
    // Only when there is genuinely nothing left. This component is unmounted
    // for reasons that have nothing to do with the draft -- `Chat` swaps it for
    // the archived and cron read-only footers -- while the assistant-ui runtime
    // that actually holds the text outlives it. Resetting unconditionally said
    // "nothing is held" about a draft still sitting in that runtime, and the
    // next visibility flip reloaded over it.
    if (!draftRef.current) resetComposerDraft();
  }, []);

  const captureSelection = useCallback((input = inputRef.current) => {
    if (input === null) return;
    const next = {
      start: input.selectionStart ?? input.value.length,
      end: input.selectionEnd ?? input.value.length,
    };
    setSelection(next);
    savedBrowseSelection.current = next;
  }, []);

  const restoreSelection = useCallback((start: number, end: number, revealInput = false) => {
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input === null) return;
      if (revealInput) input.focus();
      else input.focus({ preventScroll: true });
      input.setSelectionRange(start, end);
      setSelection({ start, end });
      savedBrowseSelection.current = { start, end };
    });
  }, []);

  const insertSkill = useCallback((name: string, source: "autocomplete" | "browse") => {
    if (store.skillRegistry.status !== "ready") return;
    const skill = store.skillRegistry.items.find((candidate) => candidate.name === name);
    if (skill === undefined || !isUsableSkill(skill)) return;
    const currentText = composer.value;
    let range = source === "browse"
      ? savedBrowseSelection.current
      : {
          start: inputRef.current?.selectionStart ?? selection.start,
          end: inputRef.current?.selectionEnd ?? selection.end,
        };
    if (source === "autocomplete") {
      const currentQuery = detectSkillQuery(currentText, range.start, range.end);
      if (
        currentQuery === null
        || !rankSkills(store.skillRegistry.items, currentQuery.query)
          .some((candidate) => candidate.name === name)
      ) return;
      range = { start: currentQuery.offset, end: currentQuery.cursor };
    }
    const inserted = insertSkillReference(
      currentText,
      range.start,
      range.end,
      skill.reference,
    );
    composer.setText(inserted.text);
    // Browse opens a modal above the composer. Once it closes, let the native
    // focus scroll reveal the input as the software keyboard resizes the visual
    // viewport. Autocomplete is already adjacent to a focused input and should
    // keep its current scroll position.
    restoreSelection(inserted.selectionStart, inserted.selectionEnd, source === "browse");
  }, [composer, restoreSelection, selection.end, selection.start, store.skillRegistry]);

  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="composer-root">
        <ComposerTriggerPopover commands={commands} />
        {skillQuery !== null && autocompleteSkills.length > 0 && (
          <SkillAutocomplete
            skills={store.skillRegistry.items}
            query={skillQuery.query}
            cursor={skillQuery.cursor}
            onSelect={(name) => insertSkill(name, "autocomplete")}
          />
        )}
        <ComposerQuotePreview />
        <ComposerPrimitive.AttachmentDropzone
          className="composer-dropzone"
          disabled={!canUpload}
        >
          <AttachmentErrorListener />
          <ComposerAttachments />
          <div className="composer-input-row">
            <ComposerPrimitive.Input
              ref={inputRef}
              id="composer-input"
              className="composer-input"
              placeholder={statusText ?? (isRunning
                ? `Steer ${selectedAgent?.label ?? "the agent"} while it works…`
                : `Message ${selectedAgent?.label ?? "an agent"}…`)}
              aria-label="Message"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={false}
              rows={1}
              addAttachmentOnPaste={canUpload}
              submitMode="enter"
              unstable_insertNewlineOnTouchEnter
              unstable_focusOnRunStart={false}
              unstable_focusOnScrollToBottom={false}
              unstable_focusOnThreadSwitched={false}
              onChange={(event) => captureSelection(event.currentTarget)}
              onSelect={(event) => captureSelection(event.currentTarget)}
              onKeyUp={(event) => captureSelection(event.currentTarget)}
              onClick={(event) => captureSelection(event.currentTarget)}
            />
          </div>
          <div className="composer-toolbar">
            <div className="composer-tools">
              {canUpload && (
                <ComposerPrimitive.AddAttachment
                  className="icon-button composer-tool"
                  aria-label="Attach files"
                  title="Attach files"
                  multiple
                >
                  <Icon name="attach" size={17} />
                </ComposerPrimitive.AddAttachment>
              )}
              <SkillBrowser
                agentLabel={selectedAgent?.label}
                registry={store.skillRegistry}
                onBeforeOpen={() => captureSelection()}
                onSelect={(name) => insertSkill(name, "browse")}
              />
              <span className="composer-hint">
                {statusText ?? (isRunning ? "Enter to steer this run" : "Enter to send · / commands · $ skills")}
              </span>
            </div>
            <div className="composer-actions">
              {runSettings}
              <ComposerPrimitive.Send
                className="composer-send"
                aria-label={isRunning ? "Send live follow-up" : "Send message"}
                disabled={!canSend}
              >
                <Icon name="send" size={16} />
              </ComposerPrimitive.Send>
              {isRunning && (
                <ComposerPrimitive.Cancel className="composer-stop" aria-label="Stop response">
                  <Icon name="stop" size={14} />
                  <span>Stop</span>
                </ComposerPrimitive.Cancel>
              )}
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Root>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
