import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";

import { Icon } from "./Icon";

export interface GalleryImage {
  /** Stable per message: an attachment id or a reply part id. */
  readonly key: string;
  readonly src: string;
  readonly name: string;
}

interface GalleryRegistry {
  readonly register: (image: GalleryImage) => void;
  readonly unregister: (key: string) => void;
  readonly open: (key: string) => void;
}

const GalleryContext = createContext<GalleryRegistry | undefined>(undefined);

/**
 * Collects every image in one message so the lightbox can page across them.
 *
 * Uploads arrive as one grid while reply files each render their own card, so
 * without a shared registry the two could never be paged as a single set. Images
 * are held in insertion order, which is mount order, which is the order they are
 * shown in.
 */
export function MessageGallery({ children }: { readonly children: React.ReactNode }) {
  const [images, setImages] = useState<readonly GalleryImage[]>([]);
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);

  const register = useCallback((image: GalleryImage) => {
    setImages((current) => {
      const index = current.findIndex((candidate) => candidate.key === image.key);
      if (index === -1) return [...current, image];
      if (current[index]!.src === image.src && current[index]!.name === image.name) return current;
      const next = [...current];
      next[index] = image;
      return next;
    });
  }, []);

  const unregister = useCallback((key: string) => {
    setImages((current) => current.filter((candidate) => candidate.key !== key));
  }, []);

  const registry = useMemo<GalleryRegistry>(
    () => ({ register, unregister, open: setOpenKey }),
    [register, unregister],
  );

  const index = openKey === undefined ? -1 : images.findIndex((image) => image.key === openKey);

  return (
    <GalleryContext.Provider value={registry}>
      {children}
      {index >= 0 && (
        <Lightbox
          images={images}
          index={index}
          onIndexChange={(next) => setOpenKey(images[next]?.key)}
          onClose={() => setOpenKey(undefined)}
        />
      )}
    </GalleryContext.Provider>
  );
}

/**
 * Registers one image with the surrounding message and returns how to open it.
 * Outside a `MessageGallery` the tile still renders; it simply cannot page.
 */
export function useGalleryImage(image: GalleryImage | undefined): () => void {
  const registry = useContext(GalleryContext);
  const key = image?.key;
  const src = image?.src;
  const name = image?.name;

  useEffect(() => {
    if (registry === undefined || key === undefined || src === undefined) return undefined;
    registry.register({ key, src, name: name ?? "" });
    return () => registry.unregister(key);
  }, [registry, key, src, name]);

  return useCallback(() => {
    if (registry !== undefined && key !== undefined) registry.open(key);
  }, [registry, key]);
}

export function ImageTile({ image }: { readonly image: GalleryImage }) {
  const open = useGalleryImage(image);
  return (
    <button type="button" className="image-tile" onClick={open} aria-label={`View ${image.name}`}>
      <img src={image.src} alt={image.name} loading="lazy" decoding="async" />
    </button>
  );
}

export function ImageGrid({ images }: { readonly images: readonly GalleryImage[] }) {
  if (images.length === 0) return null;
  return (
    <div className="image-gallery">
      {images.map((image) => <ImageTile key={image.key} image={image} />)}
    </div>
  );
}

function Lightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  readonly images: readonly GalleryImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}) {
  const current = images[index]!;
  const many = images.length > 1;
  // Read through a ref so the key handler is not rebound on every step.
  const state = useRef({ index, length: images.length, onIndexChange });
  state.current = { index, length: images.length, onIndexChange };

  useEffect(() => {
    if (!many) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const { index: at, length, onIndexChange: change } = state.current;
      change(event.key === "ArrowLeft" ? (at - 1 + length) % length : (at + 1) % length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [many]);

  const step = (delta: number) => onIndexChange((index + delta + images.length) % images.length);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="lightbox-backdrop" />
        <Dialog.Popup className="lightbox-popup" aria-label={`Image ${index + 1} of ${images.length}`}>
          <Dialog.Title className="sr-only">{current.name}</Dialog.Title>
          <img className="lightbox-image" src={current.src} alt={current.name} />
          <div className="lightbox-bar">
            {many && (
              <button type="button" className="icon-button" onClick={() => step(-1)} aria-label="Previous image">
                <Icon name="chevron-left" size={18} />
              </button>
            )}
            <span className="lightbox-name">{current.name}</span>
            {many && <span className="lightbox-count">{index + 1} / {images.length}</span>}
            {many && (
              <button type="button" className="icon-button" onClick={() => step(1)} aria-label="Next image">
                <Icon name="chevron" size={18} />
              </button>
            )}
            <a
              className="icon-button"
              href={current.src}
              download={current.name}
              aria-label={`Download ${current.name}`}
            >
              <Icon name="download" size={17} />
            </a>
            <Dialog.Close className="icon-button" aria-label="Close image">
              <Icon name="close" size={17} />
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
