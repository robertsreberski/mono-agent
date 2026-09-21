import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ALLOW_ALL_TOOLS, MonoAgentConfigError, redactMonoAgentConfig, resolveConfiguredProviders } from "../index.js";
import { resolveJsonMonoAgentConfig } from "../config.js";
import type { MemoryBackend } from "../index.js";
import type { MonoAgentConfigJson } from "../json-source.js";

const baseJson: MonoAgentConfigJson = {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
};

const journalMemoryPrerequisite = {
  memory: {
    embeddings: {
      provider: "ollama"
    }
  }
};

const bujoMemoryPrerequisites = {
  memory: {
    embeddings: {
      provider: "ollama"
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    }
  }
};

describe("resolveJsonMonoAgentConfig", () => {
  it("exposes only BuJo as the active memory backend type", () => {
    const supportedBackend: MemoryBackend = "bujo";
    // @ts-expect-error Supermemory is a retired input tombstone, not an active backend.
    const retiredBackend: MemoryBackend = "supermemory";
    expect(supportedBackend).toBe("bujo");
    expect(retiredBackend).toBe("supermemory");
  });

  it("loads required runtime, context, tools, memory, and artifact config", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    effort: "high",
    maxTurns: 12,
    workspace: "workspace"
  },
  context: {
    identityPath: "IDENTITY.md",
    soulPath: "SOUL.md",
    skillsRoot: "skills",
    selectedSkills: ["research", "review"]
  },
  tools: {
    allowedTools: ["Read", "Grep"],
    disallowedTools: ["Bash"],
    mcpConfigPath: "mcp.json",
    mcpRequestContextServers: ["transcribe", "documents"],
    continuationServers: ["ops-control", "local-worker"],
    mcpCallTimeoutMs: 150000,
    mcpCallMaxTotalTimeoutMs: 2700000
  },
  memory: {
    path: "memory.md",
    writeMode: "append-host-summary",
    maxBytes: 2048
  },
  artifacts: {
    dir: "artifacts",
    retention: {
      maxAgeDays: 14,
      maxCount: 250,
      dryRun: true
    },
    memoryRetention: {
      maxAgeDays: 3,
      maxCount: 25,
      dryRun: false
    }
  },
  traceability: {
    registryDir: "trace-registry",
    sourceId: "agent-one",
    sourceLabel: "Agent One",
    heartbeatMs: 5000,
    staleAfterMs: 15000,
    globalDiscovery: false
  }
},
    });

    expect(config.runtime).toMatchObject({ effort: "high", maxTurns: 12, workspace: "/repo/workspace" });
    expect(config.runtime.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.5" });
    expect(config.context).toEqual({
      identityPath: "/repo/IDENTITY.md",
      soulPath: "/repo/SOUL.md",
      skillsRoot: "/repo/skills",
      selectedSkills: ["research", "review"],
    });
    expect(config.memory).toMatchObject({ mode: "lite", path: "/repo/memory.md", writeMode: "append-host-summary" });
    expect(config.memory).not.toHaveProperty("scope");
    expect(config.memory).not.toHaveProperty("graphPath");
    expect(config.memory).not.toHaveProperty("tools");
    expect(config.tools).toEqual({
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpConfigPath: "/repo/mcp.json",
      mcpRequestContextServers: ["transcribe", "documents"],
      continuationServers: ["ops-control", "local-worker"],
      mcpCallTimeoutMs: 150000,
      mcpCallMaxTotalTimeoutMs: 2700000,
      web: {
        coordination: "process",
        search: { backend: ["parallel", "ollama"], ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false }, maxRequestsPerRun: 4, codex: { model: "gpt-5.6-luna" } },
        fetch: { provider: "local", render: "never", browserCommand: "agent-browser" },
      },
    });
    expect(config.artifacts.dir).toBe("/repo/artifacts");
    expect(config.artifacts.retention).toEqual({ maxAgeDays: 14, maxCount: 250, dryRun: true });
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 3, maxCount: 25, dryRun: false });
    expect(config.providers?.piAuthPath).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(config.traceability).toEqual({
      registryDir: "/repo/trace-registry",
      sourceId: "agent-one",
      sourceLabel: "Agent One",
      heartbeatMs: 5000,
      staleAfterMs: 15000,
      globalDiscovery: false,
    });
  });

  it("uses finite artifact retention defaults", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });

    expect(config.runtime.compaction).toEqual({ enabled: true, fixedOverheadEnabled: true });
    expect(config.artifacts.retention).toEqual({ maxAgeDays: 365, maxCount: 50000, dryRun: false });
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 7, maxCount: 5000, dryRun: false });
    expect(config.tools.web).toEqual({
      coordination: "process",
      search: { backend: ["parallel", "ollama"], ollama: { baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false }, maxRequestsPerRun: 4, codex: { model: "gpt-5.6-luna" } },
      fetch: { provider: "local", render: "never", browserCommand: "agent-browser" },
    });
  });

  it("loads local web search and browser-render settings from env", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      coordination: "host",
      search: {
        backend: "searxng",
        maxRequestsPerRun: 7,
        endpoint: "http://127.0.0.1:8088/",
        codex: {
          model: "gpt-5.6-sol"
        }
      },
      fetch: {
        render: "auto",
        browserCommand: "/opt/homebrew/bin/agent-browser"
      }
    }
  }
},
    });

    expect(config.tools.web).toEqual({
      coordination: "host",
      search: {
        backend: "searxng",
        maxRequestsPerRun: 7,
        searxng: { endpoint: "http://127.0.0.1:8088" },
        codex: { model: "gpt-5.6-sol" },
      },
      fetch: { provider: "local", render: "auto", browserCommand: "/opt/homebrew/bin/agent-browser" },
    });
  });

  it("loads local and hosted Ollama Web Search without resolving hosted credentials", () => {
    const local = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "ollama"
      }
    }
  }
} });
    expect(local.tools.web?.search.ollama).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      trustPublicUrl: false,
    });

    const hosted = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "ollama",
        ollama: {
          baseUrl: "https://ollama.com",
          apiKeyEnv: "TEST_OLLAMA_WEB_KEY"
        }
      }
    }
  }
} });
    expect(hosted.tools.web?.search.ollama).toEqual({
      baseUrl: "https://ollama.com",
      trustPublicUrl: false,
      apiKeyEnv: "TEST_OLLAMA_WEB_KEY",
    });
    // Nothing is resolved at load, so there is no credential value to leak.
    // The reference name itself is preserved for the runtime to resolve.
    expect(hosted.tools.web?.search.ollama?.apiKey).toBeUndefined();
    expect(redactMonoAgentConfig(hosted).tools.web?.search.ollama?.apiKeyEnv).toBe("TEST_OLLAMA_WEB_KEY");
  });

  it("binds Ollama credentials to the official origin and requires trust for custom public origins", () => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "ollama",
        ollama: {
          apiKeyEnv: "TEST_OLLAMA_WEB_KEY"
        }
      }
    }
  }
} })).toThrow(/only for the exact https:\/\/ollama\.com origin/u);
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "ollama",
        ollama: {
          baseUrl: "https://search.example.com"
        }
      }
    }
  }
} })).toThrow(/TRUST_PUBLIC_URL=true/u);
    expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "ollama",
        ollama: {
          baseUrl: "https://search.example.com",
          trustPublicUrl: true
        }
      }
    }
  }
} }).tools.web?.search.ollama).toMatchObject({ baseUrl: "https://search.example.com", trustPublicUrl: true });
  });

  it("accepts the legacy SearXNG endpoint alias but rejects conflicting spellings", () => {
    expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "searxng",
        endpoint: "http://127.0.0.1:8088"
      }
    }
  }
} }).tools.web?.search.searxng?.endpoint).toBe("http://127.0.0.1:8088");
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "searxng",
        endpoint: "http://127.0.0.1:8088",
        searxng: {
          endpoint: "http://127.0.0.1:8089"
        }
      }
    }
  }
} })).toThrow(/disagree/u);
  });

  it("rejects remote or credentialed SearXNG endpoints and strict mode without an endpoint", () => {
    for (const endpoint of [
      "https://search.example.com",
      "http://user:pass@127.0.0.1:8088",
      "http://192.168.1.2:8088",
      "http://127.0.0.1:8088?format=html",
      "http://127.0.0.1:8088#fragment",
    ]) {
      expect(() => resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        endpoint: endpoint
      }
    }
  }
},
      })).toThrow(MonoAgentConfigError);
    }
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "searxng"
      }
    }
  }
},
    })).toThrow(/tools\.web\.search\.(searxng\.)?endpoint/u);
  });

  it("rejects control characters in the direct browser executable", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      fetch: {
        browserCommand: "agent-browser\t--unsafe"
      }
    }
  }
},
    })).toThrow(/tools\.web\.fetch\.browserCommand/u);
  });

  it("accepts strict Codex search without SearXNG and validates its model id", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        backend: "codex",
        codex: {
          model: "gpt-5.6-luna"
        }
      }
    }
  }
},
    });
    expect(config.tools.web?.search).toEqual({
      backend: "codex",
      maxRequestsPerRun: 4,
      codex: { model: "gpt-5.6-luna" },
    });
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        codex: {
          model: `gpt${"x".repeat(200)}`
        }
      }
    }
  }
},
    })).toThrow(/tools\.web\.search\.codex\.model/u);
  });

  it("bounds the per-run WebSearch provider-request budget", () => {
    for (const invalid of ["0", "21", "1.5", "nope"]) {
      expect(() => resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        maxRequestsPerRun: String(invalid) as never
      }
    }
  }
},
      })).toThrow(/tools\.web\.search\.maxRequestsPerRun/u);
    }
    expect(resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    web: {
      search: {
        maxRequestsPerRun: 20
      }
    }
  }
},
    }).tools.web?.search.maxRequestsPerRun).toBe(20);
  });

  it("loads every runtime compaction override from env", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    compaction: {
      enabled: false,
      triggerRatio: 0.8,
      keepRecentTokens: 9000,
      summaryMaxTokens: 3000,
      minSavingsTokens: 7000,
      fixedOverheadEnabled: false,
      contextWindowOverride: 272000
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });
    expect(config.runtime.compaction).toEqual({
      enabled: false,
      triggerRatio: 0.8,
      keepRecentTokens: 9_000,
      summaryMaxTokens: 3_000,
      minSavingsTokens: 7_000,
      fixedOverheadEnabled: false,
      contextWindowOverride: 272_000,
    });
  });

  it.each([
    [{ enabled: "sometimes" as unknown as boolean }, "runtime.compaction.enabled"],
    [{ triggerRatio: 0.1 }, "runtime.compaction.triggerRatio"],
    [{ keepRecentTokens: 3999 }, "runtime.compaction.keepRecentTokens"],
    [{ summaryMaxTokens: 999 }, "runtime.compaction.summaryMaxTokens"],
    [{ minSavingsTokens: -1 }, "runtime.compaction.minSavingsTokens"],
    [{ fixedOverheadEnabled: "sometimes" as unknown as boolean }, "runtime.compaction.fixedOverheadEnabled"],
    [{ contextWindowOverride: 31999 }, "runtime.compaction.contextWindowOverride"],
  ])("rejects invalid compaction JSON %j (%s)", (compaction, path) => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: { ...baseJson, runtime: { ...baseJson.runtime, compaction } },
    })).toThrowError(expect.objectContaining({ code: "invalid_json", details: expect.objectContaining({ path }) }));
  });

  it("expands a home-relative Pi auth path instead of treating tilde as a directory", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piAuthPath: "~/.pi/custom/auth.json"
  }
},
    });

    expect(config.providers?.piAuthPath).toBe(join(homedir(), ".pi", "custom", "auth.json"));
  });

  it("defaults memory artifact retention dry-run to the agent retention dry-run", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  artifacts: {
    retention: {
      dryRun: true
    }
  }
},
    });

    expect(config.artifacts.retention.dryRun).toBe(true);
    expect(config.artifacts.memoryRetention).toEqual({ maxAgeDays: 7, maxCount: 5000, dryRun: true });
  });

  it("rejects invalid artifact retention values", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  artifacts: {
    retention: {
      maxAgeDays: 0
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  artifacts: {
    retention: {
      maxCount: -1
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  artifacts: {
    memoryRetention: {
      maxAgeDays: 0
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  artifacts: {
    memoryRetention: {
      maxCount: -1
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("treats an omitted runtime max turns value as unlimited", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("treats runtime max turns of zero as unlimited", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    maxTurns: 0
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });

    expect(config.runtime.maxTurns).toBeUndefined();
  });

  it("omits permission mode when the env is unset", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.runtime).not.toHaveProperty("permissionMode");
  });

  it.each(["true", "false"])("loads prompt cache diagnostics %s without changing unset defaults", (value) => {
    const unset = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(unset.providers?.piNative).toEqual({ cacheRetention: "long" });
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      promptCacheDiagnostics: value === "true"
    }
  }
} });
    expect(config.providers?.piNative).toEqual({ cacheRetention: "long", promptCacheDiagnostics: value === "true" });
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      promptCacheDiagnostics: "invalid" as never
    }
  }
} })).toThrow();
  });

  it("loads prompt cache diagnostics from the provider JSON envelope", () => {
    const json = {
      ...baseJson,
      providers: { piNative: { promptCacheDiagnostics: true } },
    };
    expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json }).providers?.piNative).toEqual({ cacheRetention: "long", promptCacheDiagnostics: true });
    expect(resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: { ...json, providers: { piNative: { promptCacheDiagnostics: false } } },
    }).providers?.piNative).toEqual({ cacheRetention: "long", promptCacheDiagnostics: false });
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: { piNative: { promptCacheDiagnostics: "true" as never } }
} })).toThrow("boolean");
  });

  it("loads pi-native provider knobs from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      transport: "sse",
      piMaxRetries: 4,
      maxRetryDelayMs: 30000,
      piSessionsRoot: ".mono-agent/sessions"
    }
  }
},
    });
    expect(config.providers?.piNative).toEqual({
      cacheRetention: "long",
      transport: "sse",
      piMaxRetries: 4,
      maxRetryDelayMs: 30_000,
      piSessionsRoot: join("/repo", ".mono-agent", "sessions"),
    });
  });

  it("defaults only cache retention when pi-native provider JSON is unset", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.providers?.piNative).toEqual({ cacheRetention: "long" });
  });

  it("rejects an out-of-range pi max retries value", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      piMaxRetries: 99
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("rejects an invalid pi transport", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      transport: "long-polling" as never
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("rejects the retired permission mode with an actionable repair", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: { ...baseJson, runtime: { ...baseJson.runtime, permissionMode: "bypassPermissions" } as never },
      }),
    ).toThrow(/`runtime\.permissionMode` was removed.*configure `sandbox` for enforced tool isolation/);
  });

  it("silently ignores stale core environment variables", () => {
    const json = {
      ...baseJson,
      runtime: { ...baseJson.runtime, model: "pi:openai-codex:gpt-5.5", effort: "low" as const },
    };
    const expected = resolveJsonMonoAgentConfig({ cwd: "/repo", json });
    const attempted: Record<string, string> = {
      MONO_AGENT_MODEL: "anthropic:claude-sonnet-4-6",
      MONO_AGENT_EFFORT: "max",
      MONO_AGENT_FALLBACK_MODELS: "ollama:gemma4:31b",
      MONO_AGENT_PERMISSION_MODE: "bypassPermissions",
      MONO_AGENT_EXECUTION_MODE: "sdk",
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_OBSERVABILITY_EXPORTERS: "[]",
      MONO_AGENT_IDENTITY_PATH: "/elsewhere/IDENTITY.md",
      MONO_AGENT_MAX_TURNS: "99",
    };
    for (const [name, value] of Object.entries(attempted)) {
      process.env[name] = value;
    }
    try {
      expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json })).toEqual(expected);
    } finally {
      for (const name of Object.keys(attempted)) {
        delete process.env[name];
      }
    }
  });

  it("loads a trimmed public agent name and uses it as the default trace label", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  agent: {
    name: "  Research Partner  "
  }
},
    });

    expect(config.agent).toEqual({ name: "Research Partner" });
    expect(config.traceability.sourceLabel).toBe("Research Partner");
    expect(config.traceability.sourceId).toBeUndefined();
  });

  it("keeps an explicit trace label ahead of the public agent name", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  agent: {
    name: "Research Partner"
  },
  traceability: {
    sourceLabel: "Operations Trace"
  }
},
    });

    expect(config.agent?.name).toBe("Research Partner");
    expect(config.traceability.sourceLabel).toBe("Operations Trace");
  });

  it.each(["", "line one\nline two", "x".repeat(81)])("rejects an invalid public agent name %j", (name) => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  agent: {
    name: name
  }
} }))
      .toThrow(/agent\.name/u);
  });

  it("loads canonical fallback routes with independent effort", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    effort: "high",
    fallbacks: [
          { model: "openai-codex:gpt-5.6-sol" },
          { model: "anthropic:claude-sonnet-4-6", effort: "minimal" },
          { model: "ollama:gemma4:31b", effort: "ultra" },
        ]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });

    expect(config.runtime.fallbacks).toEqual([
      { model: expect.objectContaining({ provider: "openai-codex", model: "gpt-5.6-sol" }) },
      { model: expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-6" }), effort: "minimal" },
      { model: expect.objectContaining({ provider: "ollama", model: "gemma4:31b" }), effort: "ultra" },
    ]);
  });

  it.each(["minimal", "ultra"])("accepts the %s effort level", (effort) => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    effort: effort
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.runtime.effort).toBe(effort);
  });

  it("rejects duplicate primary and fallback routes deterministically", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "pi:openai-codex:gpt-5.5" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/Duplicate runtime route/u);

  });

  it("loads persistent instance limits and resolves its root", () => {
    const instances = { enabled: false, root: "./children", maxPerConversation: 32, idleTtlMs: 60_000, maxTurns: 500 };
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: { enabled: true, instances }
} });
    expect(config.subagents?.instances).toEqual({ ...instances, root: "/repo/children" });
  });

  it.each([null, [], { root: " " }, { enabled: "true" }, { maxPerConversation: 0 },
    { maxPerConversation: 33 }, { idleTtlMs: 59_999 }, { idleTtlMs: 604_800_001 },
    { maxTurns: 0 }, { maxTurns: 501 }, { maxTurns: 1.5 }, { unknown: true },
  ])("rejects invalid instance settings %j", (instances) => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: { instances: instances as never }
} })).toThrow(/instances/u);
  });

  it("loads subagent profiles and caps", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: {
          enabled: true,
          maxConcurrent: 3,
          definitions: [
            { name: "researcher", description: "Reads code.", prompt: "You research.", allowedTools: ["Read", "Grep"] },
            { name: "test-runner", description: "Runs tests.", promptPath: "./agents/test-runner.md", model: "openai-codex:gpt-5.6-sol", timeoutMs: 900_000 },
          ],
        }
},
    });

    expect(config.subagents?.enabled).toBe(true);
    expect(config.subagents?.maxConcurrent).toBe(3);
    expect(config.subagents?.definitions?.[0]).toEqual({
      name: "researcher",
      description: "Reads code.",
      prompt: "You research.",
      allowedTools: ["Read", "Grep"],
    });
    expect(config.subagents?.definitions?.[1]?.promptPath).toBe("/repo/agents/test-runner.md");
    expect(config.subagents?.definitions?.[1]?.model).toMatchObject({ provider: "openai-codex", model: "gpt-5.6-sol" });
  });

  it("loads named and shorthand subagent model choices", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: { models: ["openai-codex:gpt-5.5", { name: "fable", model: "anthropic:claude-fable-5-1" }] }
} });
    expect(config.subagents?.models).toEqual([
      { model: expect.objectContaining({ provider: "openai-codex", model: "gpt-5.5" }) },
      { name: "fable", model: expect.objectContaining({ provider: "anthropic", model: "claude-fable-5-1" }) },
    ]);
  });

  it.each([
    [{ models: {} }, /models must be an array/u],
    [{ models: [null] }, /string or object/u],
    [{ models: [{}] }, /model reference string/u],
    [{ models: ["not-a-reference"] }, /models\[0\] model .*not a valid runtime model reference/u],
    [{ models: [{ name: "Bad:name", model: "anthropic:x" }] }, /name must be lowercase/u],
    [{ models: [{ name: "a".repeat(41), model: "anthropic:x" }] }, /1-40/u],
    [{ models: [{ model: "anthropic:x", typo: true }] }, /unknown field "typo"/u],
    [{ models: ["anthropic:x", "pi:anthropic:x"] }, /duplicate model reference/u],
    [{ models: [{ name: "a", model: "anthropic:x" }, { name: "a", model: "anthropic:y" }] }, /duplicate model name/u],
    [{ models: [{ name: "general-purpose", model: "anthropic:x" }] }, /collides/u],
    [{ models: [{ name: "helper", model: "anthropic:x" }], definitions: [{ name: "helper", description: "d", prompt: "p" }] }, /collides/u],
    [{ models: ["private-provider:x"] }, /subagents.models\[0\].model is not available/u],
  ])("rejects invalid subagent model choices: %j", (payload, expected) => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: payload as never
} })).toThrow(expected);
  });

  it.each([1, 900_000, Number.MAX_SAFE_INTEGER])("reads detached commandTimeoutMs=%s", (commandTimeoutMs) => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: { enabled: true, commandTimeoutMs }
} });
    expect(config.subagents?.commandTimeoutMs).toBe(commandTimeoutMs);
  });

  it.each([0, -1, 1.5, "900000", null, Number.MAX_SAFE_INTEGER + 1, Infinity])("rejects invalid commandTimeoutMs=%s", (commandTimeoutMs) => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: { commandTimeoutMs: commandTimeoutMs as never }
} })).toThrow(/commandTimeoutMs must be an integer/);
  });

  it("is absent when no subagents are configured", () => {
    expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json: baseJson }).subagents).toBeUndefined();
  });

  it("loads the in-flight subagent policy", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: {
          enabled: true,
          inline: { enabled: false, allowedTools: ["Read", "Edit", "Bash"] },
        }
},
    });

    expect(config.subagents?.inline).toEqual({ enabled: false, allowedTools: ["Read", "Edit", "Bash"] });
  });

  it.each([
    ["a non-object payload", "[]", /subagents must be an object/u],
    ["a nameless definition", JSON.stringify({ definitions: [{ description: "d", prompt: "p" }] }), /name must be lowercase kebab-case/u],
    ["a non-kebab name", JSON.stringify({ definitions: [{ name: "Researcher", description: "d", prompt: "p" }] }), /name must be lowercase kebab-case/u],
    ["a duplicate name", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p" }, { name: "a", description: "d2", prompt: "p2" }] }), /duplicate definition name "a"/u],
    ["a missing description", JSON.stringify({ definitions: [{ name: "a", prompt: "p" }] }), /needs a non-empty description/u],
    ["both prompt and promptPath", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", promptPath: "./x.md" }] }), /exactly one of prompt or promptPath/u],
    ["neither prompt nor promptPath", JSON.stringify({ definitions: [{ name: "a", description: "d" }] }), /exactly one of prompt or promptPath/u],
    ["the allow-all wildcard", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", allowedTools: ["*"] }] }), /cannot use the \* wildcard/u],
    ["a self-referential Agent grant", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", allowedTools: ["Agent"] }] }), /subagents never spawn subagents/u],
    ["an out-of-range maxConcurrent", JSON.stringify({ maxConcurrent: 99 }), /maxConcurrent must be an integer between 1 and 10/u],
    ["a non-object inline policy", JSON.stringify({ inline: [] }), /inline must be an object/u],
    ["an inline allow-all wildcard", JSON.stringify({ inline: { allowedTools: ["*"] } }), /cannot use the \* wildcard/u],
    ["a profile AgentSend grant", JSON.stringify({ definitions: [{ name: "a", description: "d", prompt: "p", allowedTools: ["AgentSend"] }] }), /cannot allow Agent or AgentSend/u],
    ["an inline AgentSend grant", JSON.stringify({ inline: { allowedTools: ["AgentSend"] } }), /cannot allow Agent or AgentSend/u],
    ["an inline Agent grant", JSON.stringify({ inline: { allowedTools: ["Agent"] } }), /subagents never spawn subagents/u],
  ])("rejects %s", (_label, payload, expected) => {
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: JSON.parse(payload)
} }))
      .toThrow(expected);
  });

  it("materializes same-model retry defaults", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: baseJson });
    expect(config.runtime.retry).toEqual({ primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 });
  });

  it("reads the retry policy from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    retry: {
      primaryAttempts: 4,
      backoffMs: 250,
      maxBackoffMs: 5000
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });
    expect(config.runtime.retry).toEqual({ primaryAttempts: 4, backoffMs: 250, maxBackoffMs: 5_000 });
  });

  it.each([
    [{ primaryAttempts: 0 }, "runtime.retry.primaryAttempts"],
    [{ primaryAttempts: 11 }, "runtime.retry.primaryAttempts"],
    [{ primaryAttempts: 2.5 }, "runtime.retry.primaryAttempts"],
    [{ backoffMs: -1 }, "runtime.retry.backoffMs"],
    [{ backoffMs: 60001 }, "runtime.retry.backoffMs"],
    [{ maxBackoffMs: 300001 }, "runtime.retry.maxBackoffMs"],
  ])("rejects out-of-range %j (%s)", (retry, path) => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: { ...baseJson, runtime: { ...baseJson.runtime, retry } },
    })).toThrow(/must be an integer between/u);
  });

  it("accepts per-route attempts on canonical fallbacks", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [
          { model: "openai-codex:gpt-5.6-sol", attempts: 3 },
          { model: "anthropic:claude-sonnet-4-6", effort: "high", attempts: 2 },
          { model: "ollama:gemma4:31b" },
        ]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });
    expect(config.runtime.fallbacks?.map((entry) => entry.attempts)).toEqual([3, 2, undefined]);
  });

  it.each([0, 11, 2.5, "2"])("rejects a fallback attempts value of %s", (attempts) => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "openai-codex:gpt-5.6-sol", attempts: attempts as never }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/attempts must be an integer between 1 and 10/u);
  });

  it("rejects malformed canonical fallback entries", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ effort: "high" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/non-empty model/u);
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "openai-codex:gpt-5.6-sol", effort: "extreme" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/must be one of/u);
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "openai-codex:gpt-5.6-sol", effort: "" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/must be one of/u);
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "openai-codex:gpt-5.6-sol", efffort: "max" } as never]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow(/unknown field: efffort/u);
  });

  // Retired JSON keys fail closed with the replacement named. Stale environment
  // names are silently ignored instead (see "silently ignores stale core
  // environment variables" above): there is no surface left that reads them.
  // Retired keys arrive here via JSON.parse, the same untyped shape a config
  // file produces, so no cast hides a real excess-property error.
  it.each([
    [
      "runtime.executionMode",
      "`runtime.executionMode` was removed; mono-agent runs only the Pi runtime (SDK). Delete the key.",
      { runtime: { model: "pi:openai-codex:gpt-5.5", executionMode: "sdk" } },
    ],
    [
      "runtime.routeSafety",
      "`runtime.routeSafety` was removed; every route is Pi-native, so `per-route-native` has no meaning. Delete the key.",
      { runtime: { model: "pi:openai-codex:gpt-5.5", routeSafety: "per-route-native" } },
    ],
    [
      "runtime.fallbackModels",
      "`runtime.fallbackModels` was replaced by `runtime.fallbacks: [{ \"model\": \"...\" }]`. Replace the key with that shape.",
      { runtime: { model: "pi:openai-codex:gpt-5.5", fallbackModels: ["ollama:gemma4:31b"] } },
    ],
    [
      "memory.llm.executionMode",
      "`memory.llm.executionMode` was removed for the same reason as `runtime.executionMode`: mono-agent runs only the Pi runtime (SDK). Delete the key.",
      {
        runtime: { model: "pi:openai-codex:gpt-5.5" },
        context: { identityPath: "IDENTITY.md" },
        memory: { path: "memory", llm: { executionMode: "sdk" } },
      },
    ],
  ] as const)("rejects retired JSON key %s with migration guidance", (path, message, patch) => {
    const json = { ...baseJson, ...JSON.parse(JSON.stringify(patch)) };
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/repo", json }))
      .toThrowError(expect.objectContaining({
        code: "invalid_json",
        message,
        details: expect.objectContaining({ path }),
      }));
  });

  it("loads the Pi OAuth auth path from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piAuthPath: "/tmp/pi-auth.json"
  }
},
    });

    expect(config.providers?.piAuthPath).toBe("/tmp/pi-auth.json");
  });

  it("ignores unknown JSON memory keys without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const json = JSON.parse(JSON.stringify({
        ...baseJson,
        memory: { path: "./mem", scope: "per-conversation", graphPath: "g.jsonl" },
      }));
      const config = resolveJsonMonoAgentConfig({ json, cwd: "/repo" });
      expect(config.memory).not.toHaveProperty("scope");
      expect(config.memory).not.toHaveProperty("graphPath");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("defaults the runtime session to continuous with a 30-minute idle timeout", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: baseJson });

    expect(config.runtime.session).toEqual({ mode: "continuous", idleTimeoutMs: 1_800_000, rollover: "none" });
    expect(config.sandbox).toBeUndefined();
  });

  it("loads sandbox policy from JSON when configured", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    workspace: "workspace"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  sandbox: {
    mode: "native",
    network: {
      mode: "allowlist",
      allowlist: ["github.com", "api.github.com"]
    }
  }
},
    });

    expect(config.sandbox).toMatchObject({
      mode: "native",
      engine: "srt",
      root: "/repo/workspace",
      fallback: "fail-closed",
      network: {
        mode: "allowlist",
        allowlist: ["github.com", "api.github.com"],
      },
    });
  });

  it("rejects unsafe sandbox fallback unless explicitly opted in", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  sandbox: {
    mode: "native",
    fallback: "unsafe-host-process"
  }
},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_json",
        details: { path: "sandbox.unsafeAllowHostProcess" },
      });
      expect(String(error)).toContain("unsafeAllowHostProcess");
      return;
    }
    throw new Error("Expected unsafe sandbox fallback to fail.");
  });

  it("allows unsafe sandbox fallback with the explicit opt-in", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  sandbox: {
    mode: "native",
    fallback: "unsafe-host-process",
    unsafeAllowHostProcess: true
  }
},
    });

    expect(config.sandbox).toMatchObject({
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
  });

  it("reports the sandbox allowlist path when allowlist mode has no domains", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  sandbox: {
    mode: "native",
    network: {
      mode: "allowlist"
    }
  }
},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_json",
        details: { path: "sandbox.network.allowlist" },
      });
      expect(String(error)).toContain("allowlist network mode");
      return;
    }
    throw new Error("Expected sandbox allowlist without domains to fail.");
  });

  it("respects session JSON overrides", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      mode: "per-message",
      idleTimeoutMs: 60000
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });

    expect(config.runtime.session).toEqual({ mode: "per-message", idleTimeoutMs: 60000, rollover: "none" });
  });

  it("preserves explicit session rollover notice JSON values while omitting the unset field", () => {
    const defaults = resolveJsonMonoAgentConfig({ cwd: "/repo", json: baseJson });
    expect(defaults.runtime.session.rolloverNotice).toBeUndefined();

    const enabled = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      rolloverNotice: true
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });
    expect(enabled.runtime.session.rolloverNotice).toBe(true);

    const disabled = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      rolloverNotice: false
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });
    expect(disabled.runtime.session.rolloverNotice).toBe(false);
  });

  it("rejects an invalid session rollover notice value", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      rolloverNotice: "sometimes" as never
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_json", details: { path: "runtime.session.rolloverNotice" } });
      return;
    }
    throw new Error("Expected config load to fail.");
  });

  it("rejects an invalid session mode", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      mode: "forever"
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_json", details: { path: "runtime.session.mode" } });
      return;
    }
    throw new Error("Expected config load to fail.");
  });

  it("rejects invalid or out-of-bounds session idle timeouts", () => {
    for (const raw of ["not-a-number", "999", "86400001"]) {
      try {
        resolveJsonMonoAgentConfig({
          cwd: "/repo",
          json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    session: {
      idleTimeoutMs: String(raw) as never
    }
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_json", details: { path: "runtime.session.idleTimeoutMs" } });
        continue;
      }
      throw new Error(`Expected config load to fail for ${raw}.`);
    }
  });

  it("redacts core config without adapter-specific sections", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        providers: {
          local: [{
            id: "ollama",
            type: "ollama",
            baseUrl: "http://localhost:11434",
            apiKey: "redacted-value",
          }],
        },
      },
    });
    const redacted = redactMonoAgentConfig(config);

    expect("telegram" in redacted).toBe(false);
    expect(redacted.runtime.model).toMatchObject({ provider: "openai-codex" });
    expect(redacted.providers?.local?.[0]).toMatchObject({
      id: "ollama",
      type: "ollama",
      apiKey: { present: true, redacted: true },
    });
    expect(redacted.providers?.piAuthPath).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(JSON.stringify(redacted)).not.toContain("redacted-value");
  });

  it("preserves non-secret pi-native provider knobs through redaction", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
    piNative: {
      transport: "websocket-cached",
      piMaxRetries: 4,
      maxRetryDelayMs: 30000,
      piSessionsRoot: ".mono-agent/sessions"
    }
  }
},
    });
    const redacted = redactMonoAgentConfig(config);
    expect(redacted.providers?.piNative).toEqual({
      cacheRetention: "long",
      transport: "websocket-cached",
      piMaxRetries: 4,
      maxRetryDelayMs: 30_000,
      piSessionsRoot: join("/repo", ".mono-agent", "sessions"),
    });
  });

  it("defaults traceability to a host-shared registry path", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: baseJson,
    });

    expect(config.traceability.registryDir).toMatch(/\.mono-agent\/trace-sources$/u);
  });

  it("defaults traceability.globalDiscovery to true so agents mirror into the machine-wide registry", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: baseJson,
    });

    expect(config.traceability.globalDiscovery).toBe(true);
  });

  it("rejects a non-boolean MONO_AGENT_TRACE_GLOBAL_DISCOVERY", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  traceability: {
    globalDiscovery: "sometimes" as never
  }
},
      }),
    ).toThrow(MonoAgentConfigError);
  });

  it("loads a local Ollama provider from the providers.local array shape", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        runtime: { model: "pi:ollama:qwen3:8b" },
        providers: {
          local: [{
            id: "ollama",
            type: "ollama",
            baseUrl: "http://localhost:11434",
            enabled: true,
            trustPublicUrl: false,
            apiKey: "redacted-value",
          }],
        },
      },
    });

    expect(config.providers?.local?.[0]).toMatchObject({
      id: "ollama",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      enabled: true,
      trustPublicUrl: false,
      apiKey: "redacted-value",
    });
  });

  it("loads a local provider registry from the providers.local array", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        runtime: { model: "pi:ollama:qwen3:8b" },
        providers: {
          local: [
            {
              id: "ollama",
              type: "ollama",
              baseUrl: "http://localhost:11434",
              enabled: true,
              models: [{ name: "qwen3:8b", capabilities: { context_window: 32768 } }],
            },
          ],
        },
      },
    });

    expect(config.providers?.local?.[0]?.models?.[0]).toMatchObject({
      name: "qwen3:8b",
      capabilities: { context_window: 32768 },
    });
  });

  it("rejects a bare non-builtin provider entry that Pi cannot reach", () => {
    // A bare `{}` for an id Pi has no catalog for validated, advertised nothing,
    // and only failed at turn time with `pi model not found`.
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "private-provider:model-one"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: { "private-provider": {} }
},
    })).toThrow('give providers.private-provider a "baseUrl"');
  });

  it("resolves a provider-map entry into the deterministic shared view", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "private-provider:model-one"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
          "private-provider": { type: "openai_compat", baseUrl: "http://localhost:9000" },
          openrouter: { models: [{ name: "anthropic/claude-opus-4.5" }] },
        }
},
    });

    const resolved = resolveConfiguredProviders(config);
    expect(resolved.entries.map((provider) => provider.id)).toEqual(["openrouter", "private-provider"]);
    expect(resolved.byId.get("private-provider")).toMatchObject({
      id: "private-provider",
      enabled: true,
      maxAdvertisedModels: 100,
    });
    expect(resolved.byId.get("openrouter")?.models).toEqual([
      expect.objectContaining({ name: "anthropic/claude-opus-4.5" }),
    ]);
  });

  it("reads reserved Pi settings from the providers JSON map", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
          piAuthPath: "~/.worklab/auth.json",
          piNative: {
            transport: "websocket",
            piMaxRetries: 4,
            maxRetryDelayMs: 30_000,
            piSessionsRoot: ".mono-agent/pi-sessions",
          },
        }
},
    });

    expect(config.providers).toMatchObject({
      piAuthPath: join(homedir(), ".worklab", "auth.json"),
      piNative: {
        transport: "websocket",
        piMaxRetries: 4,
        maxRetryDelayMs: 30_000,
        piSessionsRoot: "/repo/.mono-agent/pi-sessions",
      },
    });
  });

  it("migrates providers.local[] to the same effective provider set as the map shape", () => {
    const common = {
      type: "ollama",
      baseUrl: "http://localhost:11434",
      models: [{ name: "qwen3:8b" }],
    } as const;
    const fromMap = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "ollama:qwen3:8b"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: { ollama: common }
},
    });
    const fromLegacy = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "ollama:qwen3:8b"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: { local: [{ id: "ollama", ...common }] }
},
    });

    expect(resolveConfiguredProviders(fromLegacy).entries).toEqual(resolveConfiguredProviders(fromMap).entries);
  });

  it("rejects a duplicate id across the provider map and providers.local[] with both paths", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
          ollama: {},
          local: [{ id: "ollama", type: "ollama" }],
        }
},
    })).toThrow(/providers\.ollama.*providers\.local\[0\]|providers\.local\[0\].*providers\.ollama/u);
  });

  it("rejects an unlisted non-builtin route with the provider id and exact repair", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "private-provider:model-one"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    })).toThrow('Provider "private-provider" used by runtime.model is not available; add "providers": { "private-provider": { "type": "openai_compat", "baseUrl": "https://..." } }');
  });

  it("rejects an unlisted provider named only by a subagent profile model", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: {
          definitions: [
            { name: "researcher", description: "digs", prompt: "go", model: "openai-codex:gpt-5.5" },
            { name: "reviewer", description: "checks", prompt: "go", model: "private-provider:model-one" },
          ],
        }
},
    })).toThrow('Provider "private-provider" used by subagents.definitions[1].model is not available');
  });

  it("accepts a subagent profile model whose provider is declared in the map", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: {
          "my-gateway": { type: "openai_compat", baseUrl: "http://127.0.0.1:9000/v1" },
        },
  subagents: {
          definitions: [{ name: "reviewer", description: "checks", prompt: "go", model: "my-gateway:model-one" }],
        }
},
    });

    expect(config.subagents?.definitions?.[0]?.model).toMatchObject({ provider: "my-gateway" });
  });

  it("admits a bare autodiscoverable route without fabricating a provider endpoint", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "ollama:gemma4:31b",
    fallbacks: [{ model: "lmstudio:qwen3" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
    });

    // Deliberate split of duties: load admits the route (an undeclared local id
    // is not a config error), and NOTHING here invents an endpoint the operator
    // never declared. `doctor`/`validate` owns the diagnosis -- see
    // `piModelResolutionIssue` in agent-app, which reports
    // `pi model not found: ollama:gemma4:31b` with the exact repair. Synthesizing
    // `http://localhost:11434` here would turn that honest error into a false
    // "ok" and move the failure to a connection error on the first turn.
    expect(config.providers?.local).toBeUndefined();
    expect(config.providers?.entries).toBeUndefined();
  });

  it("fills the default endpoint for an autodiscoverable provider declared as an empty entry", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "ollama:gemma4:31b"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  providers: { ollama: {} }
},
    });

    // `"providers": { "ollama": {} }` is the whole repair: the id implies the
    // type, and the type implies the localhost endpoint.
    expect(config.providers?.local).toEqual([
      expect.objectContaining({ id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true }),
    ]);
    expect(resolveConfiguredProviders(config).entries.map((entry) => entry.id)).toEqual(["ollama"]);
  });

  it("rejects invalid local-provider entries and URLs", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: { ...baseJson, providers: { local: "{not-an-array}" as unknown as [] } },
    })).toThrow(/providers\.local must be an array/u);

    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        runtime: { model: "pi:ollama:qwen3:8b" },
        providers: {
          local: [{ id: "ollama", type: "ollama", baseUrl: "http://api.example.com" }],
        },
      },
    })).toThrow(/public host/u);
  });

  it("loads sandbox filesystem scopes from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    workspace: "workspace"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  sandbox: {
    mode: "native",
    readableRoots: [".", "../shared-docs"],
    writableRoots: ["out"],
    denyWrite: [".env", "secrets/**"]
  }
},
    });

    expect(config.sandbox).toMatchObject({
      mode: "native",
      readableRoots: ["/repo/workspace", "/repo/shared-docs"],
      writableRoots: ["/repo/workspace/out"],
      denyWrite: [".env", "secrets/**"],
    });
  });

  it("loads additional file-tool roots relative to the config directory", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/agent",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    filesystem: {
      readableRoots: "../framework, ../worktrees" as never,
      writableRoots: "../worktrees" as never
    }
  }
},
    });

    expect(config.tools.filesystem).toEqual({
      readableRoots: ["/framework", "/worktrees"],
      writableRoots: ["/worktrees"],
    });
  });

  it("rejects malformed JSON-like file-tool root values instead of splitting them as CSV", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/agent",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    filesystem: {
      readableRoots: '["/projects/repo,archive"' as never
    }
  }
},
    })).toThrowError(expect.objectContaining({
      code: "invalid_json",
      details: expect.objectContaining({
        path: "tools.filesystem.readableRoots",
        reason: "invalid_string_array",
      }),
    }));
  });

  it("loads memory embeddings from env with the Ollama default model", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama",
      endpoint: "http://localhost:11434"
    }
  }
},
    });

    expect(config.memory?.embeddings).toEqual({
      provider: "ollama",
      model: "nomic-embed-text:v1.5",
      endpoint: "http://localhost:11434",
    });
  });

  it("preserves an openai apiKeyEnv reference without resolving its value at load", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        memory: {
          path: "memory",
          mode: "journal",
          embeddings: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKeyEnv: "MY_OPENAI_KEY",
          },
        },
      },
    });

    // The runtime resolves MY_OPENAI_KEY against the effective environment when
    // the provider is used; the loader keeps only the name.
    expect(config.memory?.embeddings).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      apiKeyEnv: "MY_OPENAI_KEY",
    });
    expect(config.memory?.embeddings).not.toHaveProperty("apiKey");
  });

  it("rejects openai embeddings without an api key", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "openai"
    }
  }
},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_json",
        details: { path: "memory.embeddings.apiKey" },
      });
      return;
    }
    throw new Error("Expected openai embeddings without an api key to fail.");
  });

  it("rejects any memory JSON set without a memory path", () => {
    for (const memory of [
      { embeddings: { provider: "ollama" } },
      { embeddings: { dim: 768 } },
      { mode: "bujo" },
      { writeMode: "capture" },
      { maxBytes: 8000 },
      { llm: { provider: "ollama" } },
      { llm: { model: "qwen3.6:latest" } },
      { recallTool: { enabled: true } },
      { consolidation: { enabled: true } },
      { consolidation: { cron: "0 */2 * * *" } },
    ]) {
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: { ...baseJson, memory: memory as never } });
      } catch (error) {
        expect(error).toBeInstanceOf(MonoAgentConfigError);
        expect(error).toMatchObject({ code: "invalid_json" });
        continue;
      }
      throw new Error("Expected memory extras without memory.path to fail.");
    }
  });

  it("defaults memory.recallTool on for every configured local tier", () => {
    const withEmbeddings = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    }
  }
},
    });
    expect(withEmbeddings.memory?.recallTool).toEqual({ enabled: true });

    // lite tier uses FTS-only recall and is on by default.
    const lite = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite"
  }
},
    });
    expect(lite.memory?.recallTool).toEqual({ enabled: true });

    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal"
  }
},
    })).toThrow(/requires an explicit memory\.embeddings/i);
  });

  it("lets memory.recallTool.enabled override the recallTool default in both directions", () => {
    // Explicit off on a tier that would default on.
    const forcedOff = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    },
    recallTool: {
      enabled: false
    }
  }
},
    });
    expect(forcedOff.memory?.recallTool).toEqual({ enabled: false });

    // Explicit on for lite remains accepted.
    const forcedOn = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite",
    recallTool: {
      enabled: true
    }
  }
},
    });
    expect(forcedOn.memory?.recallTool).toEqual({ enabled: true });
  });

  it("fails closed when the remember flag is set without a memory path", () => {
    // Adjacent memory flags fail closed here; omitting this one let a declared
    // capability silently resolve to memory: undefined.
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    rememberTool: {
      enabled: true
    }
  }
},
    })).toThrow(/memory\.path/u);
  });

  it("defaults memory.rememberTool on for the local backend", () => {
    const lite = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite"
  }
},
    });
    expect(lite.memory?.rememberTool).toEqual({ enabled: true });
  });

  it("lets memory.rememberTool.enabled override the local rememberTool default in both directions", () => {
    const forcedOff = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite",
    rememberTool: {
      enabled: false
    }
  }
},
    });
    expect(forcedOff.memory?.rememberTool).toEqual({ enabled: false });

    const forcedOn = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite",
    rememberTool: {
      enabled: true
    }
  }
},
    });
    expect(forcedOn.memory?.rememberTool).toEqual({ enabled: true });
  });

  it("rejects a non-boolean memory.recallTool.enabled", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    },
    recallTool: {
      enabled: "maybe" as never
    }
  }
},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({ code: "invalid_json", details: { path: "memory.recallTool.enabled" } });
      return;
    }
    throw new Error("Expected an invalid recallTool flag to fail.");
  });

  it("redacts the embeddings api key", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "openai",
      apiKey: "embeddings-secret"
    }
  }
},
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.embeddings?.apiKey).toEqual({ present: true, redacted: true });
    expect(JSON.stringify(redacted)).not.toContain("embeddings-secret");
  });

  it.each([
    ["an explicit BuJo selector", "bujo"],
    ["no selector", undefined],
  ] as const)("rejects an active retired memory block at the public redaction boundary with %s", (_label, backend) => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "openai",
      apiKey: "supported-embedding-secret"
    }
  }
},
    });
    const retiredValues = [
      "https://retired.invalid/private-location",
      "retired-api-key",
      "PRIVATE_RETIRED_KEY_ENV",
    ];
    const legacyConfig = {
      ...config,
      memory: {
        ...config.memory,
        ...(backend === undefined ? {} : { backend }),
        supermemory: {
          baseUrl: retiredValues[0],
          apiKey: retiredValues[1],
          apiKeyEnv: retiredValues[2],
        },
      },
    } as unknown as typeof config;

    let rejection: unknown;
    try {
      redactMonoAgentConfig(legacyConfig);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(MonoAgentConfigError);
    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: { path: "memory.supermemory", paths: ["memory.supermemory"] },
    });
    const diagnostic = rejection instanceof Error
      ? JSON.stringify({ message: rejection.message, ...(rejection instanceof MonoAgentConfigError ? { details: rejection.details } : {}) })
      : "";
    expect(retiredValues.some((value) => diagnostic.includes(value))).toBe(false);
  });

  it("rejects a trim-normalized retired selector at the public redaction boundary", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "lite"
  }
},
    });
    const legacyConfig = {
      ...config,
      memory: { ...config.memory, backend: "  supermemory  ", supermemory: {} },
    } as unknown as typeof config;

    expect(() => redactMonoAgentConfig(legacyConfig)).toThrowError(expect.objectContaining({
      code: "invalid_json",
      details: expect.objectContaining({ path: "memory.backend", paths: ["memory.backend"] }),
    }));
  });

  it("accepts but omits an inert retired memory tombstone while preserving supported redaction", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "openai",
      apiKey: "supported-embedding-secret"
    }
  }
},
    });
    const legacyConfig = {
      ...config,
      memory: { ...config.memory, supermemory: {} },
    } as unknown as typeof config;

    const redacted = redactMonoAgentConfig(legacyConfig);
    expect(redacted.memory?.embeddings?.apiKey).toEqual({ present: true, redacted: true });
    expect(redacted.memory).not.toHaveProperty("supermemory");
    expect(JSON.stringify(redacted).includes("supported-embedding-secret")).toBe(false);
  });

  it("loads context.skillMaxBytes from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md",
    skillMaxBytes: 24000
  }
},
    });

    expect(config.context.skillMaxBytes).toBe(24000);
  });

  it("omits skillMaxBytes when unset and rejects invalid values", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.context.skillMaxBytes).toBeUndefined();

    for (const raw of ["not-a-number", "0", "1000001"]) {
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md",
    skillMaxBytes: String(raw) as never
  }
} });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_json", details: { path: "context.skillMaxBytes" } });
        continue;
      }
      throw new Error(`Expected config load to fail for ${raw}.`);
    }
  });

  it("loads concurrency.maxConcurrentRuns from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  concurrency: {
    maxConcurrentRuns: 4
  }
},
    });

    expect(config.concurrency?.maxConcurrentRuns).toBe(4);
  });

  it("loads concurrency.maxPendingRuns from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  concurrency: {
    maxPendingRuns: 16
  }
},
    });

    expect(config.concurrency?.maxPendingRuns).toBe(16);
    // maxPendingRuns is independent of maxConcurrentRuns: setting only it still
    // omits the unset sibling.
    expect(config.concurrency?.maxConcurrentRuns).toBeUndefined();
  });

  it("loads both concurrency bounds together from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  concurrency: {
    maxConcurrentRuns: 4,
    maxPendingRuns: 16
  }
},
    });

    expect(config.concurrency?.maxConcurrentRuns).toBe(4);
    expect(config.concurrency?.maxPendingRuns).toBe(16);
  });

  it("omits concurrency when unset and rejects invalid values", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.concurrency).toBeUndefined();

    for (const raw of ["not-a-number", "0", "-1"]) {
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  concurrency: {
    maxConcurrentRuns: String(raw) as never
  }
} });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_json", details: { path: "concurrency.maxConcurrentRuns" } });
        continue;
      }
      throw new Error(`Expected concurrency load to fail for ${raw}.`);
    }

    for (const raw of ["not-a-number", "0", "-1"]) {
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  concurrency: {
    maxPendingRuns: String(raw) as never
  }
} });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_json", details: { path: "concurrency.maxPendingRuns" } });
        continue;
      }
      throw new Error(`Expected pending-runs load to fail for ${raw}.`);
    }
  });

  it("loads memory embeddings timeoutMs and circuit breaker from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama",
      timeoutMs: 5000,
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMs: 20000
      }
    }
  }
},
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "ollama",
      timeoutMs: 5000,
      circuitBreaker: { failureThreshold: 5, cooldownMs: 20000 },
    });
  });

  it("omits embeddings timeoutMs/circuitBreaker when unset and rejects invalid values", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    }
  }
},
    });
    expect(config.memory?.embeddings).not.toHaveProperty("timeoutMs");
    expect(config.memory?.embeddings).not.toHaveProperty("circuitBreaker");

    const invalidByPath: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ timeoutMs: 0 }, "memory.embeddings.timeoutMs"],
      [{ timeoutMs: "not-a-number" }, "memory.embeddings.timeoutMs"],
      [{ circuitBreaker: { failureThreshold: 0 } }, "memory.embeddings.circuitBreaker.failureThreshold"],
      [{ circuitBreaker: { cooldownMs: -1 } }, "memory.embeddings.circuitBreaker.cooldownMs"],
    ];
    for (const [embeddings, path] of invalidByPath) {
      try {
        resolveJsonMonoAgentConfig({
          cwd: "/repo",
          json: {
            ...baseJson,
            memory: { path: "memory", mode: "journal", embeddings: { provider: "ollama", ...embeddings } },
          },
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_json", details: { path } });
        continue;
      }
      throw new Error(`Expected embeddings load to fail for ${path}.`);
    }
  });

  it("rejects embeddings timeoutMs and circuit breaker JSON without a memory path", () => {
    for (const embeddings of [
      { timeoutMs: 5000 },
      { circuitBreaker: { failureThreshold: 5 } },
      { circuitBreaker: { cooldownMs: 60000 } },
    ]) {
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: { ...baseJson, memory: { embeddings } } });
      } catch (error) {
        expect(error).toBeInstanceOf(MonoAgentConfigError);
        expect(error).toMatchObject({ code: "invalid_json" });
        continue;
      }
      throw new Error(`Expected ${JSON.stringify(embeddings)} without memory.path to fail.`);
    }
  });

  it("redacts the non-secret embeddings tuning fields", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory",
    mode: "journal",
    embeddings: {
      provider: "ollama",
      timeoutMs: 5000,
      circuitBreaker: {
        failureThreshold: 5
      }
    }
  }
},
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.embeddings?.timeoutMs).toBe(5000);
    expect(redacted.memory?.embeddings?.circuitBreaker).toEqual({ failureThreshold: 5 });
  });

  it("ignores unknown top-level JSON keys and keeps them out of validation errors", () => {
    const json = JSON.parse(JSON.stringify({
      ...baseJson,
      telegram: { botToken: "123456:super-secret-token" },
      runtime: { ...baseJson.runtime, maxTurns: "not-a-number" },
    }));
    try {
      resolveJsonMonoAgentConfig({ cwd: "/repo", json });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("super-secret-token");
      expect(error).toMatchObject({ code: "invalid_json" });
      return;
    }
    throw new Error("Expected config load to fail.");
  });

  it("rejects memory.mode bujo when either prerequisite is omitted", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "bujo"
  }
},
    })).toThrow(/requires an explicit memory\.embeddings/i);
  });

  it.each(["lite", "journal"] as const)(
    "rejects a partial memory.llm block in %s mode instead of silently dropping it",
    (mode) => {
      expect(() => resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
          ...baseJson,
          memory: {
            path: "memory-root",
            mode,
            ...(mode === "journal" ? { embeddings: { provider: "ollama" as const } } : {}),
            llm: { provider: "ollama" as const, endpoint: "http://localhost:11434" },
          },
        },
      })).toThrowError(expect.objectContaining({
        code: "invalid_json",
        details: expect.objectContaining({ path: "memory.mode" }),
      }));
    },
  );

  it("rejects a partial BuJo memory.llm block when its model is missing", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "ollama",
      endpoint: "http://localhost:11434"
    }
  }
},
    })).toThrowError(expect.objectContaining({
      code: "invalid_json",
      details: expect.objectContaining({ path: "memory.llm" }),
    }));
  });

  it("loads memory.llm from JSON when model is set", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434"
    }
  }
},
    });

    expect(config.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434",
    });
  });

  it("loads agent-host memory.llm with a runtime model reference", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5"
    }
  }
},
    });

    expect(config.memory?.llm).toEqual({
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
    });
  });

  it("loads agent-host memory.llm timeoutMs when set", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "agent-host",
      model: "pi:opencode-go:kimi-k2.6",
      timeoutMs: 120000
    }
  }
},
    });

    expect(config.memory?.llm).toMatchObject({
      provider: "agent-host",
      model: "pi:opencode-go:kimi-k2.6",
      timeoutMs: 120000,
    });
  });

  it("rejects memory.llm timeoutMs when the provider is not agent-host", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest",
      timeoutMs: 120000
    }
  }
},
      }),
    ).toThrow(/memory\.llm\.timeoutMs is only valid when/u);
  });

  it("rejects agent-host memory.llm endpoint because runtime models do not use Ollama endpoints", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "agent-host",
      model: "pi:openai-codex:gpt-5.5",
      endpoint: "http://localhost:11434"
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("rejects invalid agent-host memory.llm model references", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "agent-host",
      model: "not-a-runtime-model"
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_model_reference" }));
  });

  it("rejects bujo when the memory LLM is unset", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo"
  }
},
    })).toThrow(/requires an explicit memory\.llm/i);
  });

  it("omits memory.llm.endpoint when only provider and model are set", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      model: "qwen3:8b"
    }
  }
},
    });

    expect(config.memory?.llm).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(config.memory?.llm?.provider).toBe("ollama");
    if (config.memory?.llm?.provider !== "ollama") {
      throw new Error("Expected ollama memory LLM config.");
    }
    expect(config.memory.llm.endpoint).toBeUndefined();
  });

  it("rejects an unsupported memory.llm provider", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    llm: {
      model: "gpt-4o",
      provider: "openai" as never
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("does not treat LM Studio as a memory LLM provider", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "lmstudio" as never,
      model: "chat-model"
    }
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("loads memory.embeddings.dim from JSON", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama",
      dim: 768
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    },
    path: "memory-root",
    mode: "bujo"
  }
},
    });

    expect(config.memory?.embeddings?.dim).toBe(768);
  });

  it("loads LM Studio embeddings without requiring an API key", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "lmstudio",
      endpoint: "http://localhost:1234"
    }
  }
},
    });

    expect(config.memory?.embeddings).toEqual({
      provider: "lmstudio",
      model: "text-embedding-nomic-embed-text-v1.5",
      endpoint: "http://localhost:1234",
    });
  });

  it("preserves an unresolved LM Studio apiKeyEnv without treating its name as a key", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "lmstudio",
      model: "embed-model",
      apiKeyEnv: "LM_STUDIO_API_KEY"
    }
  }
},
    });

    expect(config.memory?.embeddings).toMatchObject({
      provider: "lmstudio",
      model: "embed-model",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    });
    expect(config.memory?.embeddings?.apiKey).toBeUndefined();
  });

  it("does not substitute a generic literal when a declared LM Studio apiKeyEnv is unresolved", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "lmstudio",
      apiKeyEnv: "LM_STUDIO_API_KEY",
      apiKey: "stale-provider-secret"
    }
  }
},
    });

    expect(config.memory?.embeddings?.apiKeyEnv).toBe("LM_STUDIO_API_KEY");
    expect(config.memory?.embeddings?.apiKey).toBeUndefined();
  });

  it("does not let a generic literal satisfy an unresolved OpenAI apiKeyEnv", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "openai",
      apiKeyEnv: "OPENAI_EMBEDDINGS_KEY",
      apiKey: "stale-provider-secret"
    }
  }
},
    })).toThrow(/openai memory embeddings require/u);
  });

  it("keeps an inline apiKey literal alongside an apiKeyEnv reference without resolving either", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        memory: {
          path: "memory-root",
          mode: "journal",
          embeddings: {
            provider: "lmstudio",
            model: "embed-model",
            apiKeyEnv: "LM_STUDIO_API_KEY",
            apiKey: "stale-provider-secret",
          },
        },
      },
    });

    // Neither value is resolved at load: the inline literal is preserved as-is
    // and the named reference stays a name for the runtime to resolve.
    expect(config.memory?.embeddings).toMatchObject({
      provider: "lmstudio",
      apiKey: "stale-provider-secret",
      apiKeyEnv: "LM_STUDIO_API_KEY",
    });
  });

  it("omits embeddings.dim when the env is unset", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    }
  }
},
    });

    expect(config.memory?.embeddings?.dim).toBeUndefined();
  });

  it("redacts bujo config without leaking llm model or endpoint (no secrets to redact)", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "memory-root",
    mode: "bujo",
    llm: {
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434"
    }
  }
},
    });
    const redacted = redactMonoAgentConfig(config);

    expect(redacted.memory?.mode).toBe("bujo");
    expect(redacted.memory?.llm).toEqual({
      provider: "ollama",
      model: "qwen3.6:latest",
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects invalid memory mode from env", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "unknown-mode" as never
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("rejects the removed 'markdown' mode from env", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "markdown" as never
  }
},
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_json" }));
  });

  it("loads memory.mode lite from env (FTS-only, no embeddings required)", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "lite"
  }
},
    });

    expect(config.memory?.mode).toBe("lite");
    expect(config.memory?.embeddings).toBeUndefined();
    expect(config.memory?.llm).toBeUndefined();
  });

  it("defaults memory mode to lite when path is set but mode is unset", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root"
  }
},
    });

    expect(config.memory?.mode).toBe("lite");
  });

  it("loads memory.mode journal from env", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "journal",
    embeddings: {
      provider: "ollama"
    }
  }
},
    });

    expect(config.memory?.mode).toBe("journal");
  });

  it("loads memory.consolidation from env when enabled and cron are set", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    },
    path: "memory-root",
    mode: "bujo",
    consolidation: {
      enabled: true,
      cron: "0 */2 * * *"
    }
  }
},
    });

    expect(config.memory?.consolidation).toEqual({ enabled: true, cron: "0 */2 * * *" });
  });

  it("omits consolidation when neither enabled nor cron env vars are set", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    },
    path: "memory-root",
    mode: "bujo"
  }
},
    });

    expect(config.memory?.consolidation).toBeUndefined();
  });

  it("loads a consolidation block with only cron set (enabled omitted)", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    },
    path: "memory-root",
    mode: "bujo",
    consolidation: {
      cron: "30 */4 * * *"
    }
  }
},
    });

    expect(config.memory?.consolidation).toEqual({ cron: "30 */4 * * *" });
    expect(config.memory?.consolidation?.enabled).toBeUndefined();
  });

  it("loads a consolidation block with only enabled set (cron omitted)", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    llm: {
      provider: "ollama",
      model: "qwen3.6:latest"
    },
    path: "memory-root",
    mode: "bujo",
    consolidation: {
      enabled: false
    }
  }
},
    });

    expect(config.memory?.consolidation).toEqual({ enabled: false });
    expect(config.memory?.consolidation?.cron).toBeUndefined();
  });

  it("ignores removed reflection and migration JSON blocks without requiring a memory path", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        memory: {
          reflection: { enabled: true, cron: "0 3 * * *" },
          migration: { enabled: true },
        },
      },
    });

    expect(config.memory).toBeUndefined();
  });

  it("accepts memory.writeMode 'capture' with mode 'bujo'", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "./mem",
    mode: "bujo",
    writeMode: "capture",
    llm: {
      model: "qwen3.6:latest"
    }
  }
},
    });
    expect(config.memory?.writeMode).toBe("capture");
  });

  it("rejects memory.writeMode 'capture' unless mode is 'bujo'", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "./mem",
    mode: "journal",
    writeMode: "capture"
  }
},
      }),
    ).toThrow(/capture.*requires.*bujo/i);
  });

  it("defaults memory.backend to 'bujo' when a memory block is configured", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    embeddings: {
      provider: "ollama"
    },
    path: "./mem",
    mode: "journal"
  }
},
    });
    expect(config.memory?.backend).toBe("bujo");
  });

  it.each(["supermemory", "  supermemory  "])(
    "rejects the retired Supermemory backend selector before routing (%j)",
    (backend) => {
      let rejection: unknown;
      try {
        resolveJsonMonoAgentConfig({
          cwd: "/repo",
          json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    backend: backend as never
  }
},
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        code: "invalid_json",
        details: {
          path: "memory.backend",
          paths: ["memory.backend"],
        },
      });
      expect(String(rejection)).toContain("no longer accepts `supermemory`");
    },
  );

  // A non-empty `memory.supermemory` block fails closed even without the
  // retired backend selector: the block itself is the removed surface.
  it("rejects a retired Supermemory block without a backend selector", () => {
    const block = {
      baseUrl: "https://retired.invalid/secret-path",
      apiKey: "sm-secret-value",
      apiKeyEnv: "SECRET_ENV_NAME",
      container: "secret-container",
      timeoutMs: 5000,
      exposeMcpServer: false,
    };
    let rejection: unknown;
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: { ...baseJson, memory: { path: "memory", supermemory: block as never } },
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: { path: "memory.supermemory", paths: ["memory.supermemory"] },
    });
    const rendered = `${String(rejection)} ${JSON.stringify((rejection as MonoAgentConfigError).details)}`;
    expect(rendered).toContain("memory.supermemory");
    for (const value of Object.values(block)) {
      expect(rendered).not.toContain(String(value));
    }
  });

  it("rejects a retired Supermemory block even alongside valid local memory", () => {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: {
        ...baseJson,
        memory: {
          backend: "bujo",
          path: "memory",
          mode: "lite",
          supermemory: { baseUrl: "https://retired.invalid/" } as never,
        },
      },
    })).toThrowError(expect.objectContaining({
      code: "invalid_json",
      details: expect.objectContaining({ path: "memory.supermemory" }),
    }));
  });

  it("reports the retired selector and Supermemory block without resolving or echoing values", () => {
    const supermemory = {
      baseUrl: "https://retired.invalid/secret-path",
      apiKey: "sm-secret-value",
      apiKeyEnv: "SECRET_ENV_NAME",
      container: "secret-container",
      timeoutMs: 5000,
      exposeMcpServer: false,
    };
    let rejection: unknown;
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: { ...baseJson, memory: { backend: "supermemory" as never, path: "memory", supermemory: supermemory as never } },
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: {
        path: "memory.backend",
        paths: ["memory.backend", "memory.supermemory"],
      },
    });
    const rendered = `${String(rejection)} ${JSON.stringify((rejection as MonoAgentConfigError).details)}`;
    for (const value of Object.values(supermemory)) {
      expect(rendered).not.toContain(String(value));
    }
  });

  it("tolerates an empty retired Supermemory tombstone and stale blank selectors", () => {
    const config = resolveJsonMonoAgentConfig({
      cwd: "/repo",
      json: { ...baseJson, memory: { path: "memory", supermemory: {} } },
    });
    expect(config.memory).toMatchObject({ path: "/repo/memory" });
    expect(config.memory).not.toHaveProperty("supermemory");
  });

  it("keeps explicit and padded BuJo selectors unchanged", () => {
    for (const backend of ["bujo", "  bujo  "]) {
      const config = resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    backend: backend as never,
    path: "memory",
    mode: "lite"
  }
},
      });
      expect(config.memory?.backend).toBe("bujo");
    }
  });

  it.each(["Supermemory", "SUPERMEMORY", "none", "off"])(
    "keeps noncanonical backend %j on the ordinary validation path",
    (backend) => {
      let rejection: unknown;
      try {
        resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    backend: backend as never
  }
} });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toMatchObject({
        code: "invalid_json",
        details: { path: "memory.backend", paths: ["memory.backend"] },
      });
      expect(String(rejection)).toContain("no longer accepts `supermemory`");
    },
  );

  it.each([[undefined], [{}], [{ exporters: [] }]])(
    "accepts an absent or inert removed exporter block (%j)",
    (observability) => {
      const config = resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: observability === undefined ? baseJson : { ...baseJson, observability },
      });
      expect(config).not.toHaveProperty("observability");
    },
  );

  it("rejects an active removed exporter block secret-safely", () => {
    try {
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
          ...baseJson,
          observability: { exporters: [{ type: "phoenix", headers: { authorization: "Bearer secret-token" } }] as unknown as never[] },
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect(error).toMatchObject({
        code: "invalid_json",
        details: expect.objectContaining({ path: "observability" }),
      });
      expect(String(error)).toContain("observability.exporters");
      expect(String(error)).not.toContain("secret-token");
      return;
    }
    throw new Error("Expected a removed exporter block to fail.");
  });
});

describe("resolveJsonMonoAgentConfig tools.allowedTools default", () => {
  it("defaults to allow-all (['*']) when MONO_AGENT_ALLOWED_TOOLS is unset", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
    expect(config.tools.allowedTools).toEqual([ALLOW_ALL_TOOLS]);
    expect(ALLOW_ALL_TOOLS).toBe("*");
  });

  it("resolves an explicit empty MONO_AGENT_ALLOWED_TOOLS to [] (chat-only)", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    allowedTools: []
  }
} });
    expect(config.tools.allowedTools).toEqual([]);
  });

  it("resolves MONO_AGENT_ALLOWED_TOOLS='*' to ['*']", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    allowedTools: ["*"]
  }
} });
    expect(config.tools.allowedTools).toEqual(["*"]);
  });

  it("resolves an explicit tool list unchanged", () => {
    const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  tools: {
    allowedTools: ["Read", "Bash"]
  }
} });
    expect(config.tools.allowedTools).toEqual(["Read", "Bash"]);
  });
});

/**
 * `mono-agent migrate-config` was removed on the argument that hand-migration is safe
 * because the loader names the exact repair for every rejected value. For model
 * references that was false: the parser builds the replacement, the runtime adapter nests
 * it in `details.reason`, and config threw it away. Every operator surface — `doctor`,
 * `mono-agent validate`, `config --json`, startup — renders only `error.message`, so the
 * message is the only place a repair can actually reach a human.
 */
describe("rejected model references name their replacement in the message", () => {
  it("names openai-codex for a retired codex: primary", () => {
    try {
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "codex:gpt-5.6-sol"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
      throw new Error("Expected codex:gpt-5.6-sol to be rejected.");
    } catch (error) {
      expect(error).toBeInstanceOf(MonoAgentConfigError);
      expect((error as MonoAgentConfigError).code).toBe("invalid_model_reference");
      expect((error as MonoAgentConfigError).message).toContain("openai-codex:gpt-5.6-sol");
      expect((error as MonoAgentConfigError).message).toContain("codex:gpt-5.6-sol");
      // One framing sentence, not two: config unwraps the adapter's own generic wrapper
      // rather than nesting it inside its own.
      expect((error as MonoAgentConfigError).message).not.toContain("Invalid runtime model reference");
      expect((error as MonoAgentConfigError).details.reason).toBe(
        "codex is no longer a runtime backend; use openai-codex:gpt-5.6-sol",
      );
    }
  });

  it("names anthropic for a retired claude: primary", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "claude:claude-sonnet-4-6"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} }),
    ).toThrow(/anthropic:claude-sonnet-4-6/u);
  });

  it("names the direct replacement for a retired vercel: primary", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "vercel:openai:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} }),
    ).toThrow(/use openai:gpt-5\.5 directly/u);
  });

  it("names the surviving ACP bridge for a retired acp: primary", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "acp:some-agent"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} }),
    ).toThrow(/mono-agent bridge acp/u);
  });

  it("names openai-codex for a retired codex: fallback route", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5",
    fallbacks: [{ model: "codex:gpt-5.6-sol" }]
  },
  context: {
    identityPath: "IDENTITY.md"
  }
},
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("names openai-codex for a retired codex: subagent model", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  subagents: {
            enabled: true,
            definitions: [
              { name: "helper", description: "d", prompt: "p", model: "codex:gpt-5.6-sol" },
            ],
          }
},
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("names openai-codex for a retired codex: agent-host memory LLM", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({
        cwd: "/repo",
        json: {
  runtime: {
    model: "pi:openai-codex:gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  },
  memory: {
    path: "memory-root",
    mode: "bujo",
    llm: {
      provider: "agent-host",
      model: "codex:gpt-5.6-sol"
    }
  }
},
      }),
    ).toThrow(/openai-codex:gpt-5\.6-sol/u);
  });

  it("still names the grammar for a reference with no structural separator", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "gpt-5.5"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} }),
    ).toThrow(/expected <provider>:<model>/u);
  });

  it("still names the tier-alias repair", () => {
    expect(() =>
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: "anthropic:opus"
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} }),
    ).toThrow(/tier aliases are not valid model ids/u);
  });
});

/**
 * Hand-migration is only safe if one load names everything that still has to change.
 * Retired settings are the bulk of a 0.21.0 migration, so the loader reports all of them
 * at once rather than making the operator re-run the loader per key — and an env var's
 * repair has to be an env repair, not a pointer at a JSON key the operator does not have.
 */
describe("retired settings are reported completely in JSON", () => {
  it("reports every retired JSON key in one load, not just the first", () => {
    // Retired keys arrive via JSON.parse, the same untyped shape a config file
    // produces, so no cast hides a real excess-property error.
    const json = JSON.parse(JSON.stringify({
      ...baseJson,
      runtime: {
        ...baseJson.runtime,
        executionMode: "sdk",
        routeSafety: "per-route-native",
        fallbackModels: ["ollama:gemma4:31b"],
      },
      memory: { llm: { executionMode: "sdk" } },
    }));
    try {
      resolveJsonMonoAgentConfig({ cwd: "/repo", json });
      throw new Error("Expected the retired JSON keys to be rejected.");
    } catch (error) {
      const message = (error as MonoAgentConfigError).message;
      expect(message).toContain("runtime.executionMode");
      expect(message).toContain("runtime.routeSafety");
      expect(message).toContain("runtime.fallbackModels");
      expect(message).toContain("memory.llm.executionMode");
      expect((error as MonoAgentConfigError).details.paths).toEqual([
        "runtime.executionMode",
        "runtime.routeSafety",
        "runtime.fallbackModels",
        "memory.llm.executionMode",
      ]);
    }
  });
});

/**
 * Naming the rejected value is what tells an operator which field to open, so it stays. But a
 * model field takes arbitrary operator text -- a token, a key, a URL with credentials pasted
 * in by mistake -- and every one of these messages is rendered into the terminal, `doctor`,
 * the daemon log and launchd's captured stdout, which are durable and routinely shared. The
 * echo is therefore bounded, and the diagnostic surfaces are line-oriented, so a value must
 * not be able to forge lines that read as the loader's own.
 */
describe("echoed model references are bounded and cannot forge diagnostic lines", () => {
  const utf8 = (value: string): number => new TextEncoder().encode(value).length;
  const oversized = `codex:${"sk-live-AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD".repeat(12)}`;
  const forged = "codex:gpt-5.6-sol\n[ok]    Core config\n    Loaded mono-agent.config.json.";

  const messageOf = (patch: MonoAgentConfigJson): string => {
    try {
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: { ...baseJson, ...patch } });
    } catch (error) {
      if (error instanceof MonoAgentConfigError) return error.message;
      throw error;
    }
    throw new Error("Expected the model reference to be rejected.");
  };

  const paths = {
    primary: (model: string) => ({ runtime: { model } }),
    fallback: (model: string) => ({
      runtime: { model: "pi:openai-codex:gpt-5.5", fallbacks: [{ model }] },
    }),
    subagent: (model: string) => ({
      subagents: {
        enabled: true,
        definitions: [{ name: "helper", description: "d", prompt: "p", model }],
      },
    }),
    memoryLlm: (model: string) => ({
      memory: {
        path: "memory-root",
        mode: "bujo" as const,
        embeddings: { provider: "ollama" as const },
        llm: { provider: "agent-host" as const, model },
      },
    }),
  } as const;
  const pathNames = Object.keys(paths) as (keyof typeof paths)[];

  it.each(pathNames)("keeps the replacement guidance for a normal bad ref on the %s path", (path) => {
    const message = messageOf(paths[path]("codex:gpt-5.6-sol"));
    expect(message).toContain("`codex:gpt-5.6-sol`");
    expect(message).toContain("use openai-codex:gpt-5.6-sol");
  });

  it.each(pathNames)("bounds an oversized value on the %s path", (path) => {
    const message = messageOf(paths[path](oversized));
    expect(utf8(oversized)).toBe(486);
    // Both halves are bounded: the echo of the operator's value and the parser's derived
    // repair, which interpolates that same value a second time.
    expect(utf8(message)).toBeLessThan(utf8(oversized));
    expect(message).toContain("…");
    expect(message).not.toContain(oversized);
    // The actionable half survives the bound.
    expect(message).toContain("use openai-codex:sk-live-AAAA");
  });

  it.each(pathNames)("escapes an embedded newline on the %s path", (path) => {
    const message = messageOf(paths[path](forged));
    expect(message).not.toContain("\n");
    expect(message.split("\n")).toHaveLength(1);
    expect(message).toContain("\\n[ok]    Core config");
  });

  it("bounds details.reason too, not only the rendered message", () => {
    try {
      resolveJsonMonoAgentConfig({ cwd: "/repo", json: {
  runtime: {
    model: oversized
  },
  context: {
    identityPath: "IDENTITY.md"
  }
} });
      throw new Error("Expected the model reference to be rejected.");
    } catch (error) {
      const details = (error as MonoAgentConfigError).details;
      expect(utf8(details.reason as string)).toBeLessThanOrEqual(224);
      expect(details.reason).not.toContain("\n");
    }
  });
});


it("reads cache retention from provider JSON, with a long default and strict values", () => {
  const json: MonoAgentConfigJson = {
    runtime: { model: "anthropic:claude-sonnet-4-6" },
    context: { identityPath: "IDENTITY.md" },
  };
  expect(resolveJsonMonoAgentConfig({ cwd: "/repo", json }).providers?.piNative?.cacheRetention).toBe("long");
  const withNative = (piNative: NonNullable<NonNullable<MonoAgentConfigJson["providers"]>["piNative"]>) => ({
    ...json,
    providers: { piNative },
  });
  expect(resolveJsonMonoAgentConfig({
    cwd: "/repo", json: withNative({ cacheRetention: "long" }),
  }).providers?.piNative?.cacheRetention).toBe("long");
  expect(resolveJsonMonoAgentConfig({
    cwd: "/repo", json: withNative({ cacheRetention: "short" }),
  }).providers?.piNative?.cacheRetention).toBe("short");
  for (const value of ["none", "1h", "invalid", true]) {
    expect(() => resolveJsonMonoAgentConfig({
      cwd: "/repo", json: withNative({ cacheRetention: value as "short" }),
    })).toThrow();
  }
});
