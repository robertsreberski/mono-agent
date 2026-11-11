import { useEffect, useId, useMemo, useRef, useState } from "react";
import { EnsureMessageGallery, useGalleryImage } from "./ImageGallery";
import { safeJson } from "./json";
import {
  MAX_TOOL_IMAGE_RESULT_CHARS,
  mayHaveToolImage,
  toolImageName,
  toolResultImageGroup,
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

/** Cluster call arrays are rebuilt by streaming updates even when results are unchanged. */
function useStableResults(values: readonly unknown[]): readonly unknown[] {
  const held = useRef(values);
  if (held.current.length !== values.length || values.some((value, index) => !Object.is(value, held.current[index]))) {
    held.current = values;
  }
  return held.current;
}

/** Shared by ordinary tool rows, clusters, subagents, and job progress payloads. */
export function ToolImageOutput({ result, imageResults, args, truncated, characters, onLoadFull }: {
  readonly result: unknown;
  readonly imageResults?: readonly unknown[];
  readonly args: unknown;
  readonly truncated: boolean;
  readonly characters?: number;
  readonly onLoadFull?: () => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [failedResults, setFailedResults] = useState<readonly unknown[]>();
  const [repairState, setRepairState] = useState<"idle" | "loading" | "failed">("idle");
  const attempted = useRef(false);
  const id = useId();
  const results = useStableResults(imageResults ?? [result]);
  const failed = failedResults === results;
  const hint = useMemo(() => results.some(mayHaveToolImage), [results]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !hint || seen) return;
    if (typeof IntersectionObserver !== "function") {
      setSeen(true);
      return;
    }
    // Native details hide their descendants; intersection therefore gates both
    // collapsed disclosures (including nested clusters) and never-seen rows.
    // Latch the first intersection so scrolling cannot replace a preview with
    // raw base64, shift the layout, or repeat validation of the same result.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hint, seen]);
  useEffect(() => {
    if (!seen || !hint || !truncated || !onLoadFull || characters === undefined
      || characters > MAX_TOOL_IMAGE_RESULT_CHARS || attempted.current) return;
    // One automatic attempt per mount. A cluster's sequential repair publishes
    // intermediate results; those updates must not start overlapping loops.
    // The independent manual Load full output control remains available.
    attempted.current = true;
    setRepairState("loading");
    void onLoadFull().then(
      (repaired) => setRepairState(repaired ? "idle" : "failed"),
      () => setRepairState("failed"),
    );
  }, [seen, hint, truncated, characters, onLoadFull]);
  const preview = useMemo(() => seen && !truncated && !failed
    ? toolResultImageGroup(results) : undefined, [seen, truncated, failed, results]);
  const name = toolImageName(args);
  return <div ref={ref} className="tool-image-output">
    {repairState === "loading" && truncated && <p role="status">Loading image output…</p>}
    {repairState === "failed" && truncated && <p role="alert">Could not load image output. The text preview is shown below.</p>}
    {failed && <p role="status">Image preview unavailable. The original output is shown below.</p>}
    {seen && hint && !truncated && !preview && !failed && (
      <p role="status">Image is too large, incomplete, or unsupported for preview. The raw output is shown below.</p>
    )}
    {preview ? <>
      <EnsureMessageGallery>
        {preview.images.map((image, index) => <Preview key={`${id}-${index}`} image={image}
          imageKey={`${id}-${index}`} name={preview.images.length === 1 ? name : `${name} (${index + 1})`}
          onError={() => setFailedResults(results)} />)}
      </EnsureMessageGallery>
      {preview.remainder !== undefined && <pre>{safeJson(preview.remainder)}</pre>}
    </> : <pre>{safeJson(result)}</pre>}
  </div>;
}
