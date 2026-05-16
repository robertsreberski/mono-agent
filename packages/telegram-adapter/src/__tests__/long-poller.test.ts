import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelegramLongPoller } from "../long-poller.js";
import type {
  TelegramBotApi,
  TelegramDeleteWebhookParams,
  TelegramEditMessageTextParams,
  TelegramGetUpdatesParams,
  TelegramRequestOptions,
  TelegramSendMessageParams,
  TelegramSentMessage,
  TelegramUpdate,
} from "../types.js";

class FakeTelegramApi implements TelegramBotApi {
  readonly getUpdatesCalls: Array<{
    params: TelegramGetUpdatesParams;
    options?: TelegramRequestOptions;
  }> = [];
  readonly deleteWebhookCalls: Array<{
    params?: TelegramDeleteWebhookParams;
    options?: TelegramRequestOptions;
  }> = [];
  updateBatches: TelegramUpdate[][] = [];
  failGetUpdatesWith: Error | undefined;

  async sendMessage(_params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
    throw new Error("sendMessage is not used by TelegramLongPoller tests.");
  }

  async editMessageText(
    _params: TelegramEditMessageTextParams,
  ): Promise<TelegramSentMessage | true> {
    throw new Error("editMessageText is not used by TelegramLongPoller tests.");
  }

  async getUpdates(
    params: TelegramGetUpdatesParams,
    options?: TelegramRequestOptions,
  ): Promise<TelegramUpdate[]> {
    const call: { params: TelegramGetUpdatesParams; options?: TelegramRequestOptions } = { params };
    if (options !== undefined) {
      call.options = options;
    }
    this.getUpdatesCalls.push(call);
    if (this.failGetUpdatesWith !== undefined) {
      throw this.failGetUpdatesWith;
    }
    return this.updateBatches.shift() ?? [];
  }

  async deleteWebhook(
    params?: TelegramDeleteWebhookParams,
    options?: TelegramRequestOptions,
  ): Promise<true> {
    const call: { params?: TelegramDeleteWebhookParams; options?: TelegramRequestOptions } = {};
    if (params !== undefined) {
      call.params = params;
    }
    if (options !== undefined) {
      call.options = options;
    }
    this.deleteWebhookCalls.push(call);
    return true;
  }
}

describe("TelegramLongPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls getUpdates and advances offset only after each update is handled", async () => {
    const api = new FakeTelegramApi();
    api.updateBatches.push([{ update_id: 10 }, { update_id: 11 }]);
    const handled: TelegramUpdate[] = [];
    const adapter = {
      handleUpdate: vi.fn(async (update: TelegramUpdate) => {
        handled.push(update);
        if (update.update_id === 11) {
          throw new Error("handler failed");
        }
        return { kind: "ignored", updateId: update.update_id, reason: "non_message_update" } as const;
      }),
    };
    const poller = new TelegramLongPoller({
      api,
      adapter,
      initialOffset: 5,
      limit: 50,
      timeoutSeconds: 20,
      allowedUpdates: ["message"],
    });

    await expect(poller.pollOnce()).rejects.toThrow("handler failed");

    expect(api.getUpdatesCalls).toHaveLength(1);
    expect(api.getUpdatesCalls[0]?.params).toEqual({
      offset: 5,
      limit: 50,
      timeout: 20,
      allowed_updates: ["message"],
    });
    expect(handled.map((update) => update.update_id)).toEqual([10, 11]);
    expect(poller.nextOffset).toBe(11);
  });

  it("processes batches sequentially and sends the next offset on later polls", async () => {
    const api = new FakeTelegramApi();
    api.updateBatches.push([{ update_id: 20 }, { update_id: 21 }], []);
    const adapter = {
      handleUpdate: vi.fn(async (update: TelegramUpdate) =>
        ({ kind: "ignored", updateId: update.update_id, reason: "non_message_update" }) as const,
      ),
    };
    const poller = new TelegramLongPoller({ api, adapter });

    await expect(poller.pollOnce()).resolves.toBe(2);
    await expect(poller.pollOnce()).resolves.toBe(0);

    expect(poller.nextOffset).toBe(22);
    expect(api.getUpdatesCalls[0]?.params.offset).toBeUndefined();
    expect(api.getUpdatesCalls[1]?.params.offset).toBe(22);
  });

  it("can delete an existing webhook before long polling", async () => {
    const api = new FakeTelegramApi();
    const controller = new AbortController();
    api.updateBatches.push([]);
    const originalGetUpdates = api.getUpdates.bind(api);
    api.getUpdates = async (params, options) => {
      controller.abort();
      return await originalGetUpdates(params, options);
    };
    const poller = new TelegramLongPoller({
      api,
      adapter: {
        handleUpdate: vi.fn(),
      },
      deleteWebhookOnStart: true,
      dropPendingUpdates: true,
    });

    await poller.start({ signal: controller.signal });

    expect(api.deleteWebhookCalls).toHaveLength(1);
    expect(api.deleteWebhookCalls[0]?.params).toEqual({ drop_pending_updates: true });
    expect(api.deleteWebhookCalls[0]?.options?.signal).toBe(controller.signal);
  });

  it("invokes onError, backs off, and stops cleanly when aborted", async () => {
    const api = new FakeTelegramApi();
    api.failGetUpdatesWith = new Error("temporary network failure");
    const onError = vi.fn(async () => undefined);
    const controller = new AbortController();
    const poller = new TelegramLongPoller({
      api,
      adapter: { handleUpdate: vi.fn() },
      backoff: { initialMs: 100, maxMs: 100 },
      onError,
    });

    const started = poller.start({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    await expect(started).resolves.toBeUndefined();
  });
});
