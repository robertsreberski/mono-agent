# Package Layers

`scripts/package-catalog.mjs` is the source of truth for package category metadata and dependency boundary checks. The workspace layout remains flat under `packages/<package-name>`; the diagram shows logical layers, not filesystem nesting.

```mermaid
flowchart TB
  subgraph HostDemos["Host/demo composition"]
    FinalDemo["demos/final-agent"]
    MultiDemo["demos/multi-agent"]
  end

  subgraph OperatorSurfaces["operator-surface"]
    OperatorConsole["@mono-agent/operator-console"]
    Tui["@mono-agent/tui"]
  end

  subgraph Communication["communication"]
    A2A["@mono-agent/a2a-adapter"]
    Cron["@mono-agent/cron-adapter"]
    OpenAIApi["@mono-agent/openai-api-adapter"]
    Slack["@mono-agent/slack-adapter"]
    Telegram["@mono-agent/telegram-adapter"]
    WhatsApp["@mono-agent/whatsapp-adapter"]
    Webhook["@mono-agent/webhook-adapter"]
  end

  subgraph Execution["execution"]
    Harness["@mono-agent/agent-harness"]
    Host["@mono-agent/agent-host"]
    Orchestrator["@mono-agent/agent-orchestrator"]
  end

  subgraph ContextLayer["context"]
    Context["@mono-agent/context"]
    Skills["@mono-agent/skills"]
    Memory["@mono-agent/memory-md"]
  end

  subgraph ObservabilityLayer["observability"]
    Observability["@mono-agent/observability"]
  end

  subgraph EvaluationLayer["evaluation"]
    AgentEvals["@mono-agent/agent-evals"]
  end

  subgraph Core["core"]
    Contracts["@mono-agent/agent-contracts"]
    Settings["@mono-agent/settings"]
    Config["@mono-agent/config"]
    ToolPolicy["@mono-agent/tool-policy"]
  end

  subgraph Runtime["runtime"]
    RuntimeAdapter["@mono-agent/runtime-adapter"]
    AgentRuntime["@mono-agent/agent-runtime"]
    ClaudeAgents["@mono-agent/claude-agents-runtime"]
    OpenAIAgents["@mono-agent/openai-agents-runtime"]
    CodexApp["@mono-agent/codex-app-runtime"]
  end

  FinalDemo --> OperatorConsole
  FinalDemo --> A2A
  FinalDemo --> OpenAIApi
  FinalDemo --> Telegram
  FinalDemo --> Host
  FinalDemo --> Config

  MultiDemo --> OperatorConsole
  MultiDemo --> A2A
  MultiDemo --> Telegram
  MultiDemo --> Orchestrator
  MultiDemo --> Host
  MultiDemo --> Config

  OperatorConsole --> Settings
  OperatorConsole --> Observability
  Tui --> Contracts
  Tui --> Config

  A2A --> Contracts
  A2A --> Settings
  Cron --> Contracts
  Cron --> Settings
  OpenAIApi --> Contracts
  OpenAIApi --> Settings
  Slack --> Contracts
  Slack --> Settings
  Telegram --> Contracts
  Telegram --> Settings
  WhatsApp --> Contracts
  WhatsApp --> Settings
  Webhook --> Contracts
  Webhook --> Settings

  Host --> Harness
  Host --> Config
  Host --> Memory
  Host --> Observability
  Host --> RuntimeAdapter
  Host --> ToolPolicy
  Harness --> Contracts
  Harness --> Context
  Harness --> Memory
  Harness --> Observability
  Harness --> RuntimeAdapter
  Harness --> Skills
  Harness --> ToolPolicy
  Orchestrator --> Contracts
  Orchestrator -.->|request-scoped MCP runtime options| Harness
  AgentEvals --> Contracts
  AgentEvals --> Harness
  AgentEvals --> Observability

  Config --> Settings
  Config --> RuntimeAdapter
  Skills --> Context
  RuntimeAdapter --> AgentRuntime
  ClaudeAgents --> RuntimeAdapter
  OpenAIAgents --> RuntimeAdapter
  CodexApp --> RuntimeAdapter
```

## Current Packages

| Layer | Packages |
| --- | --- |
| `runtime` | `@mono-agent/runtime-adapter`, `@mono-agent/claude-agents-runtime`, `@mono-agent/openai-agents-runtime`, `@mono-agent/codex-app-runtime` |
| `core` | `@mono-agent/agent-contracts`, `@mono-agent/config`, `@mono-agent/settings`, `@mono-agent/tool-policy` |
| `context` | `@mono-agent/context`, `@mono-agent/skills`, `@mono-agent/memory-md` |
| `execution` | `@mono-agent/agent-harness`, `@mono-agent/agent-host`, `@mono-agent/agent-orchestrator` |
| `observability` | `@mono-agent/observability` |
| `evaluation` | `@mono-agent/agent-evals` |
| `communication` | `@mono-agent/a2a-adapter`, `@mono-agent/cron-adapter`, `@mono-agent/openai-api-adapter`, `@mono-agent/slack-adapter`, `@mono-agent/telegram-adapter`, `@mono-agent/webhook-adapter`, `@mono-agent/whatsapp-adapter` |
| `operator-surface` | `@mono-agent/operator-console`, `@mono-agent/tui` |

The original `@mono-agent/runtime-adapter` wraps the legacy `@mono-agent/agent-runtime` external package (claude / claude-code-cli / codex-app-cli / pi-sdk backends). The three new runtime packages — `claude-agents-runtime`, `openai-agents-runtime`, `codex-app-runtime` — are first-class, in-repo adapters that wrap their respective SDKs directly. Hosts choose one runtime per responder at composition time via `createConfiguredAgentResponder({ runtime, model })`.
