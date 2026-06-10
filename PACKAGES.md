# Package Layers

`scripts/package-catalog.mjs` is the source of truth for package category metadata and dependency boundary checks. The workspace layout remains flat under `packages/<package-name>`; the diagram shows logical layers, not filesystem nesting.

```mermaid
flowchart TB
  subgraph HostDemos["Host/demo composition"]
    FinalDemo["demos/final-agent"]
    MultiDemo["demos/multi-agent"]
  end

  subgraph OperatorSurfaces["operator-surface"]
    OperatorConsole["@worklab-ai/operator-console"]
    Tui["@worklab-ai/tui"]
  end

  subgraph Communication["communication"]
    A2A["@worklab-ai/a2a-adapter"]
    Cron["@worklab-ai/cron-adapter"]
    OpenAIApi["@worklab-ai/openai-api-adapter"]
    Slack["@worklab-ai/slack-adapter"]
    Telegram["@worklab-ai/telegram-adapter"]
    WhatsApp["@worklab-ai/whatsapp-adapter"]
    Webhook["@worklab-ai/webhook-adapter"]
  end

  subgraph Execution["execution"]
    Harness["@worklab-ai/agent-harness"]
    Host["@worklab-ai/agent-host"]
    Orchestrator["@worklab-ai/agent-orchestrator"]
  end

  subgraph ContextLayer["context"]
    Context["@worklab-ai/context"]
    Skills["@worklab-ai/skills"]
    Memory["@worklab-ai/memory-md"]
  end

  subgraph ObservabilityLayer["observability"]
    Observability["@worklab-ai/observability"]
  end

  subgraph EvaluationLayer["evaluation"]
    AgentEvals["@worklab-ai/agent-evals"]
  end

  subgraph Core["core"]
    Contracts["@worklab-ai/agent-contracts"]
    Settings["@worklab-ai/settings"]
    Config["@worklab-ai/config"]
    ToolPolicy["@worklab-ai/tool-policy"]
  end

  subgraph Runtime["runtime"]
    RuntimeAdapter["@worklab-ai/runtime-adapter"]
    AgentRuntime["@worklab-ai/agent-runtime"]
    ClaudeAgents["@worklab-ai/claude-agents-runtime"]
    OpenAIAgents["@worklab-ai/openai-agents-runtime"]
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
```

## Current Packages

| Layer | Packages |
| --- | --- |
| `runtime` | `@worklab-ai/runtime-adapter`, `@worklab-ai/claude-agents-runtime`, `@worklab-ai/openai-agents-runtime` |
| `core` | `@worklab-ai/agent-contracts`, `@worklab-ai/config`, `@worklab-ai/settings`, `@worklab-ai/tool-policy` |
| `context` | `@worklab-ai/context`, `@worklab-ai/skills`, `@worklab-ai/memory-md` |
| `execution` | `@worklab-ai/agent-harness`, `@worklab-ai/agent-host`, `@worklab-ai/agent-orchestrator` |
| `observability` | `@worklab-ai/observability` |
| `evaluation` | `@worklab-ai/agent-evals` |
| `communication` | `@worklab-ai/a2a-adapter`, `@worklab-ai/cron-adapter`, `@worklab-ai/openai-api-adapter`, `@worklab-ai/slack-adapter`, `@worklab-ai/telegram-adapter`, `@worklab-ai/webhook-adapter`, `@worklab-ai/whatsapp-adapter` |
| `operator-surface` | `@worklab-ai/operator-console`, `@worklab-ai/tui` |

`@worklab-ai/runtime-adapter` wraps the in-repo `@worklab-ai/agent-runtime` package (claude / claude-code-cli / codex-app-cli / pi-sdk backends, with provider session support). The `claude-agents-runtime` and `openai-agents-runtime` packages are additional first-class adapters that wrap their respective SDKs directly; Codex flows through the agent-runtime codex-app bridge. Hosts choose one runtime per responder at composition time via `createConfiguredAgentResponder({ runtime, model })`.
