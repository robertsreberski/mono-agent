import { afterEach, describe, expect, it, vi } from "vitest";

import { dataUsage, resetDataUsage } from "../data-usage";
import { writeDataModeSetting } from "../data-mode";
import {
  LEAN_REPLY_IMAGE_RETENTION_BYTES,
  LEAN_REPLY_IMAGE_RETENTION_LIMIT,
  LEAN_REPLY_IMAGE_RETENTION_MS,
  REPLY_IMAGE_REQUEST_TIMEOUT_MS,
  REPLY_IMAGE_RETENTION_BYTES,
  REPLY_IMAGE_RETENTION_LIMIT,
  REPLY_IMAGE_RETENTION_MS,
  acquireReplyImageBlob,
  clearReplyImageBlobs,
  clearRetainedReplyImages,
  dropReplyImageFetch,
  joinReplyImageFetch,
  publishReplyImageBlob,
  releaseReplyImageBlob,
  replyImageKey,
  replyImageRetentionBytes,
  replyImageRetentionLimit,
  replyImageRetentionMs,
  retainedReplyImageBytes,
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

  it("gives back the bytes of every image whose window has already closed", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const size = Math.ceil(REPLY_IMAGE_RETENTION_BYTES / 4);
    // Eight complete lifetimes — published, released, and left to expire — is
    // twice the ceiling in bytes that have come and gone.
    for (let index = 0; index < 8; index += 1) {
      const key = replyImageKey(`sha256:expired-${index}`, size);
      publishReplyImageBlob(key, { size } as Blob);
      releaseReplyImageBlob(key);
      vi.advanceTimersByTime(REPLY_IMAGE_RETENTION_MS);
    }

    expect(revokeObjectURL).toHaveBeenCalledTimes(8);
    // Nothing is being held for anybody, so nothing counts against the ceiling.
    expect(retainedReplyImageBytes()).toBe(0);

    // The ceiling is about what the store is holding NOW. A picture released
    // after all of that gets its whole window, or "scroll away and back" pays
    // for the same bytes again for the life of the document.
    const current = replyImageKey("sha256:current", size);
    publishReplyImageBlob(current, { size } as Blob);
    releaseReplyImageBlob(current);

    expect(revokeObjectURL).toHaveBeenCalledTimes(8);
    expect(retainedReplyImageBytes()).toBe(size);
    expect(acquireReplyImageBlob(current)).toBe("blob:image-9");
    expect(retainedReplyImageBytes()).toBe(0);
  });

  it("gives back the bytes of an image a viewer took back before its window closed", () => {
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const size = Math.ceil(REPLY_IMAGE_RETENTION_BYTES / 2);
    const reclaimed = replyImageKey("sha256:reclaimed", size);
    publishReplyImageBlob(reclaimed, { size } as Blob);
    releaseReplyImageBlob(reclaimed);
    // Shown again inside its window, so it is no longer waiting for anybody.
    expect(acquireReplyImageBlob(reclaimed)).toBe("blob:image-1");

    const next = replyImageKey("sha256:next", size);
    publishReplyImageBlob(next, { size } as Blob);
    releaseReplyImageBlob(next);

    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(acquireReplyImageBlob(next)).toBe("blob:image-2");
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

  it("clears an abandoned request's deadline exactly once", async () => {
    const key = replyImageKey("sha256:abc", 4);
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const request = joinReplyImageFetch(key, pendingFetch);

    dropReplyImageFetch(key, request);
    await expect(request).rejects.toThrow();

    // The abandon path and the request's own settle both close the slot; only
    // one of them owns the timer id.
    expect(clearTimeout).toHaveBeenCalledTimes(1);
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

describe("what a picture costs", () => {
  afterEach(() => {
    resetDataUsage();
    localStorage.clear();
  });

  it("charges the session for the bytes of a picture, exactly once", () => {
    stubObjectUrls();
    resetDataUsage();
    const key = replyImageKey("sha256:abc", 4);

    publishReplyImageBlob(key, new Blob(["abcd"]));
    // A second viewer of the same picture joins the bytes already here; it did
    // not fetch them, so it must not be charged for them.
    publishReplyImageBlob(key, new Blob(["abcd"]));

    expect(dataUsage().bytes).toBe(4);
  });

  it("keeps far less on a lean device, because a phone runs out of memory first", () => {
    writeDataModeSetting("lean");

    expect(replyImageRetentionMs()).toBe(LEAN_REPLY_IMAGE_RETENTION_MS);
    expect(replyImageRetentionLimit()).toBe(LEAN_REPLY_IMAGE_RETENTION_LIMIT);
    expect(replyImageRetentionBytes()).toBe(LEAN_REPLY_IMAGE_RETENTION_BYTES);
    expect(LEAN_REPLY_IMAGE_RETENTION_MS).toBeLessThan(REPLY_IMAGE_RETENTION_MS);
    expect(LEAN_REPLY_IMAGE_RETENTION_LIMIT).toBeLessThan(REPLY_IMAGE_RETENTION_LIMIT);
    expect(LEAN_REPLY_IMAGE_RETENTION_BYTES).toBeLessThan(REPLY_IMAGE_RETENTION_BYTES);

    writeDataModeSetting("full");
    expect(replyImageRetentionMs()).toBe(REPLY_IMAGE_RETENTION_MS);
  });

  it("frees down to the lean ceiling the moment the operator asks for lean", () => {
    // The knobs are read at the moment of a decision, so without this the
    // tighter bounds only take effect on the NEXT release -- which on a settled
    // conversation may be never, leaving a phone holding a full-mode cache
    // after its operator asked for lean.
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();

    for (let index = 0; index <= LEAN_REPLY_IMAGE_RETENTION_LIMIT; index += 1) {
      const key = replyImageKey(`sha256:switch-${String(index)}`, 4);
      publishReplyImageBlob(key, new Blob(["abcd"]));
      releaseReplyImageBlob(key);
    }
    // Nine unreferenced pictures is well inside the full-mode bound.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    writeDataModeSetting("lean");

    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
  });

  it("re-times what it is already holding when the mode changes, in both directions", () => {
    // The ceilings answer a mode change; the retention TIMER did not. It was
    // armed at release against the window in force then and went on counting
    // down against it -- so Full -> Lean kept a picture for sixty seconds after
    // the operator asked for twenty, and Lean -> Full threw one away at twenty
    // after they asked for sixty.
    vi.useFakeTimers();
    const { revokeObjectURL } = stubObjectUrls();
    const key = replyImageKey("sha256:retimed", 4);
    publishReplyImageBlob(key, new Blob(["abcd"]));
    releaseReplyImageBlob(key);

    // Full -> Lean: the shorter window applies to the picture already waiting.
    writeDataModeSetting("lean");
    vi.advanceTimersByTime(LEAN_REPLY_IMAGE_RETENTION_MS + 1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");

    // Lean -> Full: the longer window does too, so a picture is not thrown away
    // on a bound its operator has just left behind.
    revokeObjectURL.mockClear();
    const second = replyImageKey("sha256:retimed-back", 4);
    publishReplyImageBlob(second, new Blob(["abcd"]));
    releaseReplyImageBlob(second);
    writeDataModeSetting("full");
    vi.advanceTimersByTime(LEAN_REPLY_IMAGE_RETENTION_MS + 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REPLY_IMAGE_RETENTION_MS);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-2");
  });

  it("frees a lean device's oldest pictures at the lean ceiling", () => {
    vi.useFakeTimers();
    writeDataModeSetting("lean");
    const { revokeObjectURL } = stubObjectUrls();

    for (let index = 0; index <= LEAN_REPLY_IMAGE_RETENTION_LIMIT; index += 1) {
      const key = replyImageKey(`sha256:${String(index)}`, 4);
      publishReplyImageBlob(key, new Blob(["abcd"]));
      releaseReplyImageBlob(key);
    }

    // One past the lean bound: the least recently released is gone already,
    // where a full-mode console would still be holding all of them.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
  });
});

describe("what the store gives back on request", () => {
  it("frees what nobody is holding without touching a picture on screen", () => {
    const { revokeObjectURL } = stubObjectUrls();
    const held = replyImageKey("sha256:held", 4);
    const released = replyImageKey("sha256:released", 4);
    const shown = publishReplyImageBlob(held, new Blob(["abcd"]));
    publishReplyImageBlob(released, new Blob(["abcd"]));
    releaseReplyImageBlob(released);

    clearRetainedReplyImages();

    // "Clear cached data" is about what this browser is KEEPING. Revoking a URL
    // an on-screen <img> still points at would blank the picture in front of the
    // operator, which is not what they asked for.
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:image-2");
    expect(acquireReplyImageBlob(held)).toBe(shown);
    expect(retainedReplyImageBytes()).toBe(0);
  });

  it("never parks a rejected request in the slot a later viewer would join", async () => {
    // `start` running before the slot is registered meant a SYNCHRONOUS throw
    // settled the request first and filled the slot afterwards, leaving a
    // rejected promise for the next viewer of that picture to join.
    const key = replyImageKey("sha256:throws", 4);
    const request = joinReplyImageFetch(key, () => {
      throw new Error("no transport");
    });

    await expect(request).rejects.toThrow("no transport");

    const second = joinReplyImageFetch(key, async () => new Blob(["abcd"]));
    expect(second).not.toBe(request);
    await expect(second).resolves.toBeInstanceOf(Blob);
  });

  it("clears the slot in the same turn as the failure, not one microtask later", async () => {
    // A viewer reacting to the rejection is scheduled BEFORE anything chained
    // after the handler that produced it. Clearing the slot from a `.finally`
    // therefore left one turn in which a fresh join adopted the request that had
    // just failed -- and a picture that would have retried never asked again.
    const key = replyImageKey("sha256:same-turn", 4);
    const failing = joinReplyImageFetch(key, () => Promise.reject(new Error("dropped")));
    let rejoined: Promise<Blob> | undefined;

    await failing.catch(() => {
      rejoined = joinReplyImageFetch(key, async () => new Blob(["abcd"]));
    });

    expect(rejoined).not.toBe(failing);
    await expect(rejoined!).resolves.toBeInstanceOf(Blob);
  });
});
