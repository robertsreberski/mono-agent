import { createLiveEventBus } from "@mono-agent/agent-contracts";
import { describe, expect, it, vi } from "vitest";

import { createLiveChannelDriver } from "../channels.js";

describe("live channel driver", () => {
  it("threads the app logger to the live adapter", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapterFactory = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:1234/live",
      stop: async () => undefined,
    }));
    const driver = createLiveChannelDriver({ adapterFactory });

    await driver.start({
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        basePath: "/live",
        allowNonLoopback: false,
      },
      coreConfig: {} as never,
      responder: {} as never,
      cwd: "/tmp",
      liveEventBus: createLiveEventBus(),
      logger,
      notifyDestination: async () => ({ delivered: false }),
      listNotifyDestinations: async () => [],
      postedMessageIndexPath: "/tmp/posted-message-index.jsonl",
      onFailure: vi.fn(),
      onDegraded: vi.fn(),
      onRecovered: vi.fn(),
    });

    expect(adapterFactory).toHaveBeenCalledWith(expect.objectContaining({ logger }));
  });
});
