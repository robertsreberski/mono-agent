// Fake transport only; the real native preparation/run machinery owns sessions.
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createRuntime } from "../../runtime/create-runtime.js";
/** @coreScanRetained Authored fixture imported through the conversation test source URL. */
export function preparedHostFixture(workspace: string) {
  const faux = fauxProvider({ models: [{ id: "fixture", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined } as unknown as Parameters<typeof fauxProvider>[0]);
  const models = createModels(); models.setProvider(faux.provider);
  return { runtime: createRuntime({ workspace }), faux, models,
    model: { provider: "faux", model: "fixture", reference: "faux:fixture" },
    options: { piResolvedModel: faux.getModel(), piResolvedModels: models, allowedTools: [], compaction: { enabled: false } },
    response: (text: string) => fauxAssistantMessage([fauxText(text)]) };
}
