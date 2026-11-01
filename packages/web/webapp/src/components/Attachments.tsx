import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRecordedAudio } from "../recorded-audio-context";
import { isAudioAttachment, presentTranscripts, type TranscriptPresentation } from "../voice-transcripts";
import { VoiceNote } from "./VoiceNote";
import { type GalleryImage, ImageGrid } from "./ImageGallery";
import { Icon } from "./Icon";

const announce = (message: string) => {
  window.dispatchEvent(
    new CustomEvent("mono-agent:notice", { detail: { message, tone: "error" } }),
  );
};

export function AttachmentErrorListener() {
  useAuiEvent("composer.attachmentAddError", ({ reason, message }) => {
    announce(
      reason === "not-accepted"
        ? "That file type is not supported by this agent."
        : message || "The attachment could not be uploaded.",
    );
  });
  return null;
}

function AttachmentChip({ removable }: { readonly removable: boolean }) {
  const aui = useAui();
  const status = useAuiState((state) => state.attachment.status);
  const type = useAuiState((state) => state.attachment.type);
  const name = useAuiState((state) => state.attachment.name);
  const id = useAuiState((state) => state.attachment.id);
  const localFile = useAuiState((state) => state.attachment.file);
  const contentType = useAuiState((state) => state.attachment.contentType)?.split(";", 1)[0]?.trim().toLowerCase();
  const audio = isAudioAttachment(contentType);
  const recorded = useRecordedAudio();
  const captions = useContext(TranscriptContext)?.captions;
  const content = useAuiState((state) => state.attachment.content);
  const isUploading = status.type === "running";
  const isError = status.type === "incomplete";
  const progress = isUploading ? status.progress : 100;
  const isMessageAttachment = aui.attachment.source === "message";
  const image = content?.find((part) => part.type === "image");
  const file = content?.find((part) => part.type === "file");
  const href = image?.type === "image" ? image.image : file?.type === "file" ? file.data : undefined;
  // A sent image is shown full-size by `UserMessageAttachments` instead. The
  // composer keeps its chip, where the thumbnail sits beside upload progress.
  if (isMessageAttachment && type === "image") return null;
  if (audio && contentType) return <VoiceNote key={id} id={id} name={name} contentType={contentType} file={localFile}
    recorded={Boolean(recorded?.adapter.hasRecordings([{ id }]) || recorded?.adapter.hasIncompleteRecording([{ file: localFile, status }]))}
    caption={captions?.get(id)} uploading={isUploading ? progress : undefined} failed={isError}
    onRetry={isError && localFile ? () => {
      aui.attachment().remove();
      void aui.composer().addAttachment(localFile).catch(() => announce("Upload failed. Retry or remove the file."));
    } : undefined}
    actions={<>
      {isMessageAttachment && href && <a className="icon-button" href={href} download={name} aria-label={`Download ${name}`}><Icon name="download" size={14} /></a>}
      {removable && <AttachmentPrimitive.Remove className="icon-button" aria-label="Remove file"><Icon name="close" size={14} /></AttachmentPrimitive.Remove>}
    </>} />;
  const chipContent = (
    <>
      <span className="attachment-icon">
        {image?.type === "image" && href ? (
          <img src={href} alt="" loading="lazy" />
        ) : (
          <Icon name={type === "image" ? "spark" : "file"} size={15} />
        )}
      </span>
      <span className="attachment-name">
        <AttachmentPrimitive.Name />
      </span>
    </>
  );

  const chip = (
    <AttachmentPrimitive.Root
      className={`attachment-chip${isError ? " is-error" : ""}`}
      aria-label={`${type} attachment${isUploading ? `, ${progress}% uploaded` : ""}`}
    >
      {isMessageAttachment && href ? (
        <a
          className="attachment-link"
          href={href}
          target={type === "image" ? "_blank" : undefined}
          rel={type === "image" ? "noreferrer" : undefined}
          download={type === "image" ? undefined : name}
          aria-label={`${type === "image" ? "Open" : "Download"} ${name}`}
        >
          {chipContent}
        </a>
      ) : (
        chipContent
      )}
      {isUploading && (
        <span
          className="attachment-progress"
          style={{ "--upload-progress": `${progress}%` } as React.CSSProperties}
          aria-hidden="true"
        />
      )}
      {isError && <span className="attachment-error">Upload failed</span>}
      {isError && localFile && <button type="button" className="attachment-retry" onClick={() => {
        aui.attachment().remove();
        void aui.composer().addAttachment(localFile).catch(() => announce("Upload failed. Retry or remove the file."));
      }}>Retry upload</button>}
      {removable && (
        <AttachmentPrimitive.Remove className="icon-button attachment-remove" aria-label="Remove file">
          <Icon name="close" size={14} />
        </AttachmentPrimitive.Remove>
      )}
    </AttachmentPrimitive.Root>
  );
  return chip;
}

export function ComposerAttachments({ children }: { readonly children?: ReactNode }) {
  return (
    <div className="composer-attachments">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentChip removable />}
      </ComposerPrimitive.Attachments>
      {children}
    </div>
  );
}

function useMessageImages(): readonly GalleryImage[] {
  const attachments = useAuiState((state) => state.message.attachments);
  return (attachments ?? []).flatMap((attachment): readonly GalleryImage[] => {
    if (attachment.type !== "image") return [];
    const source = attachment.content?.find((part) => part.type === "image");
    if (source?.type !== "image") return [];
    return [{ key: attachment.id, src: source.image, name: attachment.name }];
  });
}

export function UserMessageAttachments() {
  const images = useMessageImages();
  return (
    <>
      <ImageGrid images={images} />
      <div className="message-attachments">
        <MessagePrimitive.Attachments>
          {() => <AttachmentChip removable={false} />}
        </MessagePrimitive.Attachments>
      </div>
    </>
  );
}

const TranscriptContext = createContext<TranscriptPresentation | null>(null);
export function VoiceMessagePresentation({ children }: { readonly children: ReactNode }) {
  const content = useAuiState(state => state.message.content);
  const attachments = useAuiState(state => state.message.attachments);
  const presentation = useMemo(() => {
    const texts = content.filter(part => part.type === "text");
    return texts.length === 1 ? presentTranscripts(texts[0]!.text, attachments ?? []) : null;
  }, [content, attachments]);
  return <TranscriptContext.Provider value={presentation}>{children}</TranscriptContext.Provider>;
}
export function usePresentedUserText() { return useContext(TranscriptContext); }
