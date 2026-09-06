import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REPLY_IMAGE_REQUEST_TIMEOUT_MS,
  REPLY_IMAGE_RETENTION_BYTES,
  REPLY_IMAGE_RETENTION_LIMIT,
  REPLY_IMAGE_RETENTION_MS,
  acquireReplyImageBlob,
  clearReplyImageBlobs,
  dropReplyImageFetch,
  joinReplyImageFetch,
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
    const held = REPLY_IMAGE_RETENTION_LIMIT + 16;
    const keys = Array.from({ length: held }, (_, index) => replyImageKey(`sha256:${index}`, index + 1));
    for (const key of keys) {
      publishReplyImageBlob(key, new Blob(["x"]));
      releaseReplyImageBlob(key);
    }

    // The retention window has not passed for any of them, so only the bound
    // can have freed anything.
    expect(revokeObjectURL).toHaveBeenCalledTimes(held - REPLY_IMAGE_RETENTION_LIMIT);
    expect(acquireReplyImageBlob(keys[0]!)).toBeUndefined();
    expect(acquireReplyImageBlob(keys.at(-1)!)).toBe(`blob:image-${held}`);
  });

  it("bounds what it keeps by bytes, because a phone runs out of those first", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    // Two pictures that between them exceed the ceiling, well inside the count
    // bound: 24 x 20 MiB is an out-of-memory kill on the device this targets.
    const size = Math.ceil(REPLY_IMAGE_RETENTION_BYTES * 0.6);
    const first = replyImageKey("sha256:first", size);
    const second = replyImageKey("sha256:second", size);
    publishReplyImageBlob(first, { size } as Blob);
    releaseReplyImageBlob(first);
    publishReplyImageBlob(second, { size } as Blob);
    releaseReplyImageBlob(second);

    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image-1");
    expect(acquireReplyImageBlob(first)).toBeUndefined();
    expect(acquireReplyImageBlob(second)).toBe("blob:image-2");
  });

  it("counts only what nobody is holding against the byte ceiling", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const size = Math.ceil(REPLY_IMAGE_RETENTION_BYTES * 0.6);
    const shown = replyImageKey("sha256:shown", size);
    const dropped = replyImageKey("sha256:dropped", size);
    publishReplyImageBlob(shown, { size } as Blob);
    publishReplyImageBlob(dropped, { size } as Blob);
    releaseReplyImageBlob(dropped);

    // A picture on screen is not a candidate for eviction however large it is.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(acquireReplyImageBlob(dropped)).toBe("blob:image-2");
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

describe("shared reply image requests", () => {
  const pendingFetch = (signal: AbortSignal): Promise<Blob> => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
  });

  const outcomeOf = async (promise: Promise<unknown>): Promise<string> => {
    let outcome = "pending";
    void promise.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    await Promise.resolve();
    await Promise.resolve();
    return outcome;
  };

  it("asks once for a picture two viewers mount at the same moment", async () => {
    const key = replyImageKey("sha256:abc", 4);
    const start = vi.fn(pendingFetch);

    const first = joinReplyImageFetch(key, start);
    const second = joinReplyImageFetch(key, start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    // One viewer leaving does not abandon the request the other is waiting on.
    dropReplyImageFetch(key, first);
    expect(await outcomeOf(first)).toBe("pending");

    dropReplyImageFetch(key, first);
    await expect(first).rejects.toThrow();
  });

  it("starts a new request once the last viewer of the previous one has gone", async () => {
    const key = replyImageKey("sha256:abc", 4);
    const start = vi.fn(pendingFetch);
    const abandoned = joinReplyImageFetch(key, start);
    dropReplyImageFetch(key, abandoned);
    await expect(abandoned).rejects.toThrow();

    const second = joinReplyImageFetch(key, start);

    expect(start).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(abandoned);
    dropReplyImageFetch(key, second);
    await expect(second).rejects.toThrow();
  });

  it("lets a viewer of a settled request leave without abandoning the next one", async () => {
    const key = replyImageKey("sha256:abc", 4);
    const blob = new Blob(["abcd"]);
    const settled = joinReplyImageFetch(key, async () => blob);
    await expect(settled).resolves.toBe(blob);

    // A second viewer arrives and starts its own request, because the first one
    // is over.
    const next = joinReplyImageFetch(key, pendingFetch);
    // The first viewer only now unmounts and lets go of what it was waiting on.
    dropReplyImageFetch(key, settled);

    expect(await outcomeOf(next)).toBe("pending");
    dropReplyImageFetch(key, next);
    await expect(next).rejects.toThrow();
  });

  it("abandons a request that never answers, rather than holding the picture forever", async () => {
    vi.useFakeTimers();
    const key = replyImageKey("sha256:abc", 4);
    const request = joinReplyImageFetch(key, pendingFetch);

    await vi.advanceTimersByTimeAsync(REPLY_IMAGE_REQUEST_TIMEOUT_MS - 1);
    expect(await outcomeOf(request)).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);

    await expect(request).rejects.toThrow();
    // The deadline releases the slot, so a later viewer can try again.
    const retry = joinReplyImageFetch(key, pendingFetch);
    expect(retry).not.toBe(request);
    dropReplyImageFetch(key, retry);
    await expect(retry).rejects.toThrow();
  });

  it("hands its bytes to every viewer that joined the one request", async () => {
    const key = replyImageKey("sha256:abc", 4);
    const blob = new Blob(["abcd"]);
    const start = vi.fn(async () => blob);

    const first = joinReplyImageFetch(key, start);
    const second = joinReplyImageFetch(key, start);

    await expect(first).resolves.toBe(blob);
    await expect(second).resolves.toBe(blob);
    expect(start).toHaveBeenCalledTimes(1);
  });
});
