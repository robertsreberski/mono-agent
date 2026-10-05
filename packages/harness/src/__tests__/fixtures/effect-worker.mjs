import { JsonlSessionRepo } from "../../session-store.js";
import { createRunDriver } from "../../run-driver.js";
import { buildHarnessSessionContext } from "../../session-context.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.argv[2]; const repo = new JsonlSessionRepo({ sessionsRoot: root });
if (process.argv[3] === "reopen") {
  const session = await repo.open((await repo.list())[0]);
  process.send({ context: buildHarnessSessionContext(await session.getEntries(), { repairs: await session.getRepairEntries() }), seq: session.seq });
  await session.close(); process.disconnect();
} else {
  const session = await repo.create({ id: "effect-fixture" });
  const sync = session.io.sync; session.io.sync = async () => {
    await sync(); const call = [...session.validator.calls.values()].at(-1);
    if (call?.result && !call.placed) { process.send({ phase: "returned-outcome-synced" }); await new Promise(() => {}); }
  };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "effect-fixture" }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("Effect", {}, { id: "effect" })]), fauxAssistantMessage([fauxText("must not run")])]);
  const driver = createRunDriver(session, { models, model: faux.getModel(), tools: [{ name: "Effect", description: "Fictional test effect", parameters: { type: "object", properties: {} },
    execute: async () => { await writeFile(join(root, "effect-counter"), "1", { mode: 0o600 }); return { content: [{ type: "text", text: "Fictional effect observed." }] }; } }], systemPrompt: "Fictional proof", retry: { enabled: false } });
  await driver.prompt("Fictional effect request.");
  process.send({ phase: "unexpected-completion" }); process.disconnect();
}
