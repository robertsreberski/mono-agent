// A run aborted while its durable native session is held by another process
// settles promptly as cancelled and leaks no lock or busy registry entry.
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { disposeProviderSession } from "../../ai/runtime/sessions.js";

it("cancels a run waiting behind another process's native writer lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-lock-cancel-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const options = (overrides) => ({ model: { provider: "faux", model: "faux-model", reference: "faux:faux-model" }, piResolvedModel: faux.getModel(),
    piResolvedModels: models, effort: "none", allowedTools: [], piSessionsRoot: root, sessionKeepAlive: true, ...overrides });
  let holder, sessionId;
  try {
    faux.setResponses([fauxAssistantMessage([fauxText("Fictional first reply.")])]);
    const first = await generatePiNativeResponse("stable", options({ messages: [{ role: "user", content: "Fictional first ask." }] }));
    sessionId = first.providerSessionId; expect(first.error).toBeNull();
    await disposeProviderSession(sessionId); // drop liveness only; the journal stays durable
    holder = fork(new URL("./fixtures/native-writer-holder.mjs", import.meta.url), [root, sessionId], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    await Promise.race([once(holder, "message"), once(holder, "exit").then(([code]) => { throw new Error(`Writer holder exited: ${code}`); })]);

    const controller = new AbortController(), started = Date.now();
    setTimeout(() => controller.abort(), 150);
    const cancelled = await generatePiNativeResponse("stable", options({ sessionId, abortSignal: controller.signal,
      messages: [{ role: "user", content: "Fictional blocked ask." }] }));
    expect(cancelled.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);

    const exited = once(holder, "exit"); holder.kill("SIGKILL"); await exited; holder = undefined;
    faux.setResponses([fauxAssistantMessage([fauxText("Fictional resumed reply.")])]);
    const resumed = await generatePiNativeResponse("stable", options({ sessionId, messages: [{ role: "user", content: "Fictional next ask." }] }));
    expect(resumed.error).toBeNull(); expect(resumed.text).toBe("Fictional resumed reply.");
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    if (sessionId) await disposeProviderSession(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
