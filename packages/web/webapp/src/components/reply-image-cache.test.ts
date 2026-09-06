import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPLY_IMAGE_RETENTION_MS,
  acquireReplyImageBlob,
  clearReplyImageBlobs,
  publishReplyImageBlob,
  releaseReplyImageBlob,
  replyImageKey,
} from "./reply-image-cache";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

const stubObjectUrls = () => {
  let issued = 0;
  const createObjectURL = vi.fn(() => `blob:image-${++issued}`);
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
};

afterEach(() => {
  clearReplyImageBlobs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectUrl });
});

describe("shared reply image blobs", () => {
  it("mints one object URL per content identity however many viewers hold it", () => {
    const { createObjectURL } = stubObjectUrls();
    const key = replyImageKey("sha256:abc", 4);

    const first = publishReplyImageBlob(key, new Blob(["abcd"]));
    const second = publishReplyImageBlob(key, new Blob(["abcd"]));

    expect(first).toBe("blob:image-1");
    expect(second).toBe(first);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(acquireReplyImageBlob(key)).toBe(first);
  });

  it("keeps a released image alive for a remount and revokes it once the window passes", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const key = replyImageKey("sha256:abc", 4);
    const objectUrl = publishReplyImageBlob(key, new Blob(["abcd"]));

    releaseReplyImageBlob(key);
    vi.advanceTimersByTime(REPLY_IMAGE_RETENTION_MS - 1);
    // A conversation switch unmounts and remounts the same picture: the bytes
    // are still here, so nothing is fetched again.
    expect(acquireReplyImageBlob(key)).toBe(objectUrl);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    releaseReplyImageBlob(key);
    vi.advanceTimersByTime(REPLY_IMAGE_RETENTION_MS);

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(objectUrl);
    expect(acquireReplyImageBlob(key)).toBeUndefined();
  });

  it("never revokes an image a viewer still holds", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const key = replyImageKey("sha256:abc", 4);
    publishReplyImageBlob(key, new Blob(["abcd"]));
    acquireReplyImageBlob(key);

    releaseReplyImageBlob(key);
    vi.advanceTimersByTime(REPLY_IMAGE_RETENTION_MS * 4);

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("bounds what it keeps for nobody by dropping the least recently released", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const keys = Array.from({ length: 40 }, (_, index) => replyImageKey(`sha256:${index}`, index + 1));
    for (const key of keys) {
      publishReplyImageBlob(key, new Blob(["x"]));
      releaseReplyImageBlob(key);
    }

    // The retention window has not passed for any of them, so only the bound
    // can have freed anything.
    expect(revokeObjectURL).toHaveBeenCalled();
    expect(acquireReplyImageBlob(keys[0]!)).toBeUndefined();
    expect(acquireReplyImageBlob(keys.at(-1)!)).toBe("blob:image-40");
  });

  it("drops everything on demand so no object URL outlives its document", () => {
    const { revokeObjectURL } = stubObjectUrls();
    const key = replyImageKey("sha256:abc", 4);
    publishReplyImageBlob(key, new Blob(["abcd"]));

    clearReplyImageBlobs();

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image-1");
    expect(acquireReplyImageBlob(key)).toBeUndefined();
  });

  it("separates content that declares the same hash with a different length", () => {
    expect(replyImageKey("sha256:abc", 4)).not.toBe(replyImageKey("sha256:abc", 5));
  });
});
