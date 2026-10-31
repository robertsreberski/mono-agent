import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiEvent,
  useAuiState,
} from "@assistant-ui/react";
import { useEffect, useState } from "react";
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
  const audio = ["audio/webm", "audio/mp4", "audio/ogg"].includes(contentType ?? "");
  const [play, setPlay] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  useEffect(() => {
    if (!play || !audio || !contentType) return;
    const controller = new AbortController();
    let url: string | undefined;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setPreview(undefined); setPreviewError(undefined);
    void (async () => {
      try {
        let blob: Blob;
        if (localFile) { if (localFile.size > 10 * 1024 * 1024) throw new Error("Download this file to play it."); blob = localFile; }
        else {
          const response = await fetch(`/api/v1/uploads/${encodeURIComponent(id)}/content`, { signal: controller.signal });
          if (!response.ok || !response.body) throw new Error("Audio preview unavailable. Use Download.");
          const reader = response.body.getReader();
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          let size = 0;
          try {
            if (Number(response.headers.get("Content-Length")) > 10 * 1024 * 1024) throw new Error("Download this file to play it.");
            while (true) {
              const next = await reader.read(); if (next.done) break;
              size += next.value.byteLength;
              if (size > 10 * 1024 * 1024) throw new Error("Download this file to play it.");
              chunks.push(Uint8Array.from(next.value));
            }
          } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
          blob = new Blob(chunks, { type: contentType });
        }
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob); setPreview(url);
      } catch (failure) { if (!controller.signal.aborted) setPreviewError(failure instanceof Error ? failure.message : "Audio preview unavailable."); }
    })();
    return () => { clearTimeout(timeout); controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [play, audio, contentType, id, localFile]);
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
      {audio && !isUploading && <button type="button" className="audio-play" aria-label={`Preview ${name}`} onClick={() => setPlay((value) => !value)}>{play ? "Close" : "Play"}</button>}
      {isError && <span className="attachment-error">Upload failed</span>}
      {isError && localFile && <button type="button" className="audio-play attachment-retry" onClick={() => {
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
  if (!audio) return chip;
  return <div className="audio-attachment">{chip}
      {play && preview && <audio className="audio-preview" controls preload="none" src={preview} aria-label={`Audio ${name}`} />}
      {play && previewError && <span className="voice-error" role="status">{previewError}</span>}
    </div>;
}

export function ComposerAttachments() {
  return (
    <div className="composer-attachments">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentChip removable />}
      </ComposerPrimitive.Attachments>
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
