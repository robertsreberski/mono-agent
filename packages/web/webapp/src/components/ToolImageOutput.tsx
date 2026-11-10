import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MessageGallery, useGalleryImage } from "./ImageGallery";
import { safeJson } from "./json";
import {
  MAX_TOOL_IMAGE_RESULT_CHARS,
  mayHaveToolImage,
  toolImageName,
  toolResultImages,
  type ToolResultImage,
} from "./tool-result-images";

function Preview({ image, name, imageKey, onError }: {
  readonly image: ToolResultImage;
  readonly name: string;
  readonly imageKey: string;
  readonly onError: () => void;
}) {
  const [loadedSrc, setLoadedSrc] = useState<string>();
  // MIME and canonical base64 have been validated; no tool-supplied URL/markup.
  const src = `data:${image.mimeType};base64,${image.data}`;
  const loaded = loadedSrc === src;
  const open = useGalleryImage({ key: imageKey, src, name });
  return <div className="tool-image-preview">
    {!loaded && <span role="status">Loading image…</span>}
    <button type="button" onClick={open} aria-label={`View ${name}`} disabled={!loaded}>
      <img src={src} alt={name} decoding="async" onLoad={() => setLoadedSrc(src)} onError={onError} />
    </button>
  </div>;
}

/** Shared by ordinary tool rows, clusters, subagents, and job progress payloads. */
export function ToolImageOutput({ result, args, truncated, characters, onLoadFull }: {
  readonly result: unknown;
  readonly args: unknown;
  readonly truncated: boolean;
  readonly characters?: number;
  readonly onLoadFull?: () => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedResult, setFailedResult] = useState<unknown>();
  const [repairState, setRepairState] = useState<"idle" | "loading" | "failed">("idle");
  const attempted = useRef<unknown>(undefined);
  const id = useId();
  const hint = mayHaveToolImage(result);
  useEffect(() => {
    const element = ref.current;
    if (!element || !hint) return;
    // Native details hide their descendants; intersection therefore gates both
    // collapsed disclosures (including nested clusters) and offscreen rows.
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting === true));
    observer.observe(element);
    return () => observer.disconnect();
  }, [hint]);
  useEffect(() => {
    if (!visible || !hint || !truncated || !onLoadFull || characters === undefined
      || characters > MAX_TOOL_IMAGE_RESULT_CHARS || attempted.current === result) return;
    attempted.current = result;
    setRepairState("loading");
    void onLoadFull().then(
      (repaired) => setRepairState(repaired ? "idle" : "failed"),
      () => setRepairState("failed"),
    );
  }, [visible, hint, truncated, characters, onLoadFull, result]);
  const preview = useMemo(() => visible && !truncated && failedResult !== result
    ? toolResultImages(result) : undefined, [visible, truncated, failedResult, result]);
  const name = toolImageName(args);
  return <div ref={ref} className="tool-image-output">
    {repairState === "loading" && truncated && <p role="status">Loading image output…</p>}
    {repairState === "failed" && truncated && <p role="alert">Could not load image output. The text preview is shown below.</p>}
    {failedResult === result && <p role="status">Image preview unavailable. The original output is shown below.</p>}
    {preview ? <>
      <MessageGallery>
        {preview.images.map((image, index) => <Preview key={`${id}-${index}`} image={image}
          imageKey={`${id}-${index}`} name={preview.images.length === 1 ? name : `${name} (${index + 1})`}
          onError={() => setFailedResult(() => result)} />)}
      </MessageGallery>
      {preview.remainder !== undefined && <pre>{safeJson(preview.remainder)}</pre>}
    </> : <pre>{safeJson(result)}</pre>}
  </div>;
}
