import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, ready, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { createAgentHarness } from "../harness.js";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-guarded-compaction-")); roots.push(root);
  const f = await fixture(root); await ready(f); await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { });
  return { ...f, before: JSON.parse(await readFile(f.canonicalPath, "utf8")) };
}
it("manual compactConversation on a real v5 conversation fails guarded dispatch without generic invalidation/retirement (P is defence-in-depth)", async () => {
  const f = await setup(), identityPath = join(f.base, "IDENTITY.md");
  const journals = join(f.base, "native", "journals"), [current] = await readdir(journals), currentBytes = await readFile(join(journals, current!));
  await writeFile(identityPath, "Fictional instructions");
  const faux = fauxProvider({ models: [{ id: "B", contextWindow: 100000, maxTokens: 4096 }] }), models = createModels(); models.setProvider(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), runtime = createMonoRuntime({ workspace: f.base, resolvePiApiKey: async () => undefined });
  const run = runtime.run.bind(runtime); runtime.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel("B"), piResolvedModels: models });
  const invalidation = vi.spyOn(runtime, "invalidateSession"), retirement = vi.spyOn(runtime, "retireDurableSession"), execution = vi.spyOn(runtime, "run");
  const harness = createAgentHarness({ identityPath, runtime, model: { provider: "faux", model: "B", reference: "faux:B" }, historyStore: f.store,
    sessionsRoot: join(f.base, "native"), session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true }, runtimeOptions: { allowedTools: [], disallowedTools: [] } });
  try {
    await expect(harness.compactConversation!(bucket)).rejects.toMatchObject({ failureKind: "compaction_failed" });
    expect(execution).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
    expect(invalidation).not.toHaveBeenCalled(); expect(retirement).not.toHaveBeenCalled();
    // Only the owned C transaction may replace the current journal; one current journal remains.
    expect(await readdir(journals)).toHaveLength(1);
    const after = JSON.parse(await readFile(f.canonicalPath, "utf8"));
    expect(after.version).toBe(3); expect(after.lastSwitch).toEqual(f.before.lastSwitch); expect(after.native.authority).toEqual(f.before.native.authority);
    if ((await readdir(journals))[0] === current) expect(await readFile(join(journals, current!))).toEqual(currentBytes);
  } finally { await harness.dispose?.(); }
});
