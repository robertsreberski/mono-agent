// Fake transport only; the real native preparation/run machinery owns sessions.
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createRuntime } from "../../runtime.js";
export function preparedHostFixture(workspace) {
  const faux = fauxProvider({ models: [{ id: "fixture", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  return { runtime: createRuntime({ workspace }), faux, models,
    model: { provider: "faux", model: "fixture", reference: "faux:fixture" },
    options: { piResolvedModel: faux.getModel(), piResolvedModels: models, allowedTools: [], compaction: { enabled: false } },
    response: (text) => fauxAssistantMessage([fauxText(text)]) };
}
