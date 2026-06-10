# Host Blueprint

Use this blueprint when implementing or documenting a mono-agent host after the discovery questions are answered.

## Minimal File Set

```text
my-agent/
├── IDENTITY.md
├── mono-agent.config.json
├── skills/
│   └── project-skill/
│       └── SKILL.md
└── src/
    └── host.ts
```

The `skills/` directory is optional. If present, each skill must be an immediate child directory with `SKILL.md`.

## Identity

`IDENTITY.md` should state:

- the agent role
- the workspace and ownership boundary
- tool and external-write confirmation rules
- what to do when runtime, MCP, adapter, or file access fails
- the expected answer style for the host's audience

Keep identity stable. Put task-specific procedures in selected skills.

## Mono-Agent Skill Shape

Mono-agent derives a selected skill description from the first non-heading paragraph in `SKILL.md`. Start with a plain description paragraph:

```md
# Project Skill

Use this skill when the agent needs to work inside the project issue tracker and update local project notes.

## Workflow

- Read `AGENTS.md` first.
- Ask for confirmation before mutating external systems.
```

Avoid YAML frontmatter in mono-agent-selected skills unless the host has a custom parser. The built-in loader treats it as Markdown body text.

## Config

Start with adapter-neutral config and add adapter-specific sections only for chosen adapters.

```json
{
  "runtime": {
    "model": "pi:ollama:qwen3:8b",
    "executionMode": "sdk",
    "maxTurns": 8,
    "workspace": ".",
    "session": {
      "mode": "continuous",
      "idleTimeoutMs": 1800000
    }
  },
  "context": {
    "identityPath": "./IDENTITY.md",
    "skillsRoot": "./skills",
    "selectedSkills": ["project-skill"]
  },
  "memory": {
    "mode": "markdown",
    "path": "./MEMORY.md",
    "maxBytes": 64000,
    "scope": "single-file",
    "writeMode": "disabled"
  },
  "tools": {
    "allowedTools": [],
    "disallowedTools": [],
    "mcpConfigPath": "./mcp.json"
  },
  "artifacts": {
    "dir": "./.mono-agent/artifacts"
  },
  "traceability": {
    "registryDir": "~/.mono-agent/trace-sources",
    "sourceId": "my-agent",
    "sourceLabel": "My Agent",
    "heartbeatMs": 10000,
    "staleAfterMs": 30000
  }
}
```

Remove `memory` to disable memory entirely. Remove `tools.mcpConfigPath` if there is no MCP config file. Add adapter sections such as `telegram`, `a2a`, `webhook`, `openaiApi`, or `cron` only when the chosen host uses them.

## Responder Host

The smallest config-driven responder host is:

```ts
import { loadMonoAgentConfigWithSources } from "@mono-agent/config";
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const config = await loadMonoAgentConfigWithSources({
  env: process.env,
  cwd: process.cwd(),
  jsonPath: "./mono-agent.config.json",
});

const responder = createConfiguredAgentResponder({ config });
```

Attach the responder to a surface:

```ts
import { startMonoAgentTui } from "@mono-agent/tui";

await startMonoAgentTui({
  responder,
  config,
});
```

For adapter packages, pass the same responder into the adapter start function and load adapter-specific config separately from core config.

## Request-Scoped Runtime Options

Use `runtimeOptionsForRequest` only when a host needs per-request MCP servers, temporary provider context, or cleanup:

```ts
import { createConfiguredAgentResponder } from "@mono-agent/agent-host";

const responder = createConfiguredAgentResponder({
  config,
  runtimeOptionsForRequest: ({ request }) => ({
    runtimeOptions: {
      metadata: {
        transport: request.metadata?.transport,
      },
    },
    cleanup: async () => {
      // Stop request-local resources here.
    },
  }),
});
```

Do not use request-scoped options to hide missing global config. If every request needs the same setting, put it in config.

## Adapter Pattern

Adapters stay thin:

```ts
import { startOpenAIApiAdapter } from "@mono-agent/openai-api-adapter";

const api = await startOpenAIApiAdapter({
  host: "127.0.0.1",
  port: 4311,
  modelId: "agent",
  responder,
});

console.log(api.baseUrl);
```

For public or non-loopback binds, require explicit user approval, API/bearer keys where supported, and a deployment boundary such as VPN, firewall, or reverse proxy.

## Host Shutdown

Stop adapters first, then dispose the responder/harness if the returned object exposes `dispose()`. Continuous provider sessions are retired during harness disposal.

## Common Mistakes

- Selecting skills without setting `context.skillsRoot`.
- Putting adapter credentials into core config sections.
- Enabling memory writes before agreeing on what may be remembered.
- Binding HTTP adapters publicly without an explicit public deployment policy.
- Testing only package builds without a real adapter or TUI smoke.
- Importing a communication adapter from another adapter package.
