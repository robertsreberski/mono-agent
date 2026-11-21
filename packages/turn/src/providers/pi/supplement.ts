// Conservative fallback while Pi 1.6.0's native GPT-6.2 rows are verified in
// production. Remove this module and its hooks once the supplement is confirmed
// redundant. Upstream provider+id always wins, including pricing.
// Snapshots copy the pinned GPT-6.1 Sol / GPT-6 Astra siblings verbatim except
// id, name and published GPT-6.2 pricing; keep their conservative context windows.
import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { MutableModels } from "@earendil-works/pi-ai";
// Same shape as catalog.ts's PiBuiltinModelSnapshot, declared locally because
// catalog.ts imports this module (the turn contract graph forbids cycles).
type PiBuiltinModelSnapshot = Omit<import("@earendil-works/pi-ai").Model<string>, "compat"> & {
  compat?: import("@earendil-works/pi-ai/providers/compat-schema").ProviderCompat;
};

const SUPPLEMENT: PiBuiltinModelSnapshot[] = [
  {
    "id": "gpt-6.2-sol",
    "name": "GPT-6.2 Sol",
    "api": "openai-responses",
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5,
      "tiers": [
        {
          "inputTokensAbove": 272000,
          "input": 4,
          "output": 15,
          "cacheRead": 0.2,
          "cacheWrite": 5
        }
      ]
    },
    "contextWindow": 272000,
    "maxTokens": 128000,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    },
    "compat": {
      "supportsStrictMode": true,
      "supportsOpenAIGrammarTools": true,
      "supportsAdditionalTools": true,
      "supportsToolSearch": true,
      "supportsMidConvoSystemMessages": true,
      "supportsExplicitPromptCacheMode": true,
      "supportsMidConvoEffort": true
    },
    "inputLimits": {
      "maxRequestBytes": 536870912,
      "images": {
        "maxPerRequest": 1500,
        "resize": {
          "maxWidth": 2000,
          "maxHeight": 2000,
          "maxBytes": 4718592,
          "jpegQuality": 80
        }
      }
    },
    "type": "chat"
  },
  {
    "id": "gpt-6.2-astra",
    "name": "GPT-6.2 Astra",
    "api": "openai-responses",
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.4,
      "cacheWrite": 10,
      "tiers": [
        {
          "inputTokensAbove": 272000,
          "input": 16,
          "output": 60,
          "cacheRead": 0.8,
          "cacheWrite": 20
        }
      ]
    },
    "contextWindow": 272000,
    "maxTokens": 128000,
    "thinkingLevelMap": {
      "off": null,
      "minimal": null,
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    },
    "compat": {
      "supportsStrictMode": true,
      "supportsOpenAIGrammarTools": true,
      "supportsAdditionalTools": true,
      "supportsToolSearch": true,
      "supportsMidConvoSystemMessages": true,
      "supportsExplicitPromptCacheMode": true,
      "supportsMidConvoEffort": true
    },
    "inputLimits": {
      "maxRequestBytes": 536870912,
      "images": {
        "maxPerRequest": 1500,
        "resize": {
          "maxWidth": 2000,
          "maxHeight": 2000,
          "maxBytes": 4718592,
          "jpegQuality": 80
        }
      }
    },
    "type": "chat"
  },
  {
    "id": "gpt-6.2-sol",
    "name": "GPT-6.2 Sol",
    "api": "openai-codex-responses",
    "provider": "openai-codex",
    "baseUrl": "https://chatgpt.com/backend-api",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.1,
      "cacheWrite": 2.5,
      "tiers": [
        {
          "inputTokensAbove": 272000,
          "input": 4,
          "output": 15,
          "cacheRead": 0.2,
          "cacheWrite": 5
        }
      ]
    },
    "contextWindow": 500000,
    "maxTokens": 128000,
    "thinkingLevelMap": {
      "off": null,
      "minimal": "low",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    },
    "compat": {
      "supportsOpenAIGrammarTools": true,
      "supportsAdditionalTools": true,
      "supportsToolSearch": true,
      "supportsMidConvoSystemMessages": true
    },
    "inputLimits": {
      "images": {
        "resize": {
          "maxWidth": 2000,
          "maxHeight": 2000,
          "maxBytes": 4718592,
          "jpegQuality": 80
        }
      }
    },
    "type": "chat"
  },
  {
    "id": "gpt-6.2-astra",
    "name": "GPT-6.2 Astra",
    "api": "openai-codex-responses",
    "provider": "openai-codex",
    "baseUrl": "https://chatgpt.com/backend-api",
    "reasoning": true,
    "input": [
      "text",
      "image"
    ],
    "cost": {
      "input": 8,
      "output": 40,
      "cacheRead": 0.4,
      "cacheWrite": 10,
      "tiers": [
        {
          "inputTokensAbove": 272000,
          "input": 16,
          "output": 60,
          "cacheRead": 0.8,
          "cacheWrite": 20
        }
      ]
    },
    "contextWindow": 272000,
    "maxTokens": 128000,
    "thinkingLevelMap": {
      "off": null,
      "minimal": "low",
      "low": "low",
      "medium": "medium",
      "high": "high",
      "xhigh": "xhigh",
      "max": "max"
    },
    "compat": {
      "supportsOpenAIGrammarTools": true,
      "supportsAdditionalTools": true,
      "supportsToolSearch": true,
      "supportsMidConvoSystemMessages": true
    },
    "inputLimits": {
      "images": {
        "resize": {
          "maxWidth": 2000,
          "maxHeight": 2000,
          "maxBytes": 4718592,
          "jpegQuality": 80
        }
      }
    },
    "type": "chat"
  }
];

/** Internal unified catalog lookup: never override a native row. */
export function getPiCatalogModel(provider: string, id: string): PiBuiltinModelSnapshot | undefined {
  const model = getBuiltinModel(provider as any, id)
    ?? SUPPLEMENT.find((row) => row.provider === provider && row.id === id);
  return model === undefined ? undefined : structuredClone(model);
}

/** Internal unified listing: retain upstream order and append only missing rows. */
export function listPiCatalogModels(provider: string): PiBuiltinModelSnapshot[] {
  const native = getBuiltinModels(provider as any);
  return structuredClone([...native, ...SUPPLEMENT.filter((row) =>
    row.provider === provider && !native.some((model) => model.id === row.id))]);
}

/** Backfill only existing built-in providers, preserving auth/API implementations. */
export function registerPiSupplementModels(models: MutableModels): void {
  for (const providerId of new Set(SUPPLEMENT.map((row) => row.provider))) {
    const provider = models.getProvider(providerId);
    if (!provider) continue;
    const missing = SUPPLEMENT.filter((row) =>
      row.provider === providerId && models.getModel(providerId, row.id) === undefined);
    if (missing.length === 0) continue;
    const getModels = provider.getModels.bind(provider);
    // One registration per provider: a row-by-row loop can drop earlier rows.
    models.setProvider({
      ...provider,
      getModels: () => [...getModels(), ...structuredClone(missing) as any],
    });
  }
}
