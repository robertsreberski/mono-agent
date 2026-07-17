import { ComposerPrimitive, useAuiState } from "@assistant-ui/react";
import { canUploadInConsole } from "../capabilities";
import { useConsoleStore } from "../console-store";
import { AttachmentErrorListener, ComposerAttachments } from "./Attachments";
import { Icon } from "./Icon";

export function Composer() {
  const { connection, selectedAgent, selectedThread } = useConsoleStore();
  const canUpload = canUploadInConsole(connection, selectedAgent, selectedThread);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const statusText =
    selectedAgent?.status === "offline"
      ? `${selectedAgent.label} is offline`
      : selectedThread?.archivedAt
        ? "Conversation archived"
        : undefined;

  return (
    <ComposerPrimitive.Root className="composer-root">
      <ComposerPrimitive.AttachmentDropzone
        className="composer-dropzone"
        disabled={!canUpload}
      >
        <AttachmentErrorListener />
        <ComposerAttachments />
        <div className="composer-input-row">
          <ComposerPrimitive.Input
            id="composer-input"
            className="composer-input"
            placeholder={statusText ?? `Message ${selectedAgent?.label ?? "an agent"}…`}
            aria-label="Message"
            rows={1}
            addAttachmentOnPaste={canUpload}
            submitMode="enter"
            unstable_insertNewlineOnTouchEnter
            unstable_focusOnRunStart={false}
            unstable_focusOnScrollToBottom={false}
            unstable_focusOnThreadSwitched={false}
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
            <span className="composer-hint">
              {statusText ?? "Enter to send · Shift+Enter for a new line"}
            </span>
          </div>
          {isRunning ? (
            <ComposerPrimitive.Cancel className="composer-stop" aria-label="Stop response">
              <Icon name="stop" size={14} />
              <span>Stop</span>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send
              className="composer-send"
              aria-label="Send message"
              disabled={!canSend}
            >
              <Icon name="send" size={16} />
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
