# Mono Agent Composer

Use this skill when a user wants to build, configure, or troubleshoot an agent host with mono-agent packages, especially when they need help combining runtime, context, skills, memory, tool/MCP policy, communication adapters, operator surfaces, and observability into one working application.

## Operating Rules

- Start by discovering the intended agent product, not by naming packages.
- Ask one question at a time and wait for the answer unless the user has already supplied the information.
- Prefer multiple-choice questions with a recommended default when the user is deciding between common mono-agent paths.
- Keep package boundaries explicit. Adapters receive an `AgentResponder`; they do not import the harness or runtime.
- Do not fake runtime success, silently broaden tool access, or hide provider/MCP failures behind fallbacks.
- Treat memory as optional host-owned state. Enable writes only when the user asks for durable memory.
- Prefer the existing demo composition paths before inventing a new host shape.

## Discovery Loop

Read `references/discovery-questions.md` when the user has not already specified the product shape. Ask enough questions to resolve:

1. Primary surface: TUI, Telegram, Slack, WhatsApp, OpenAI API, A2A, webhook, cron, operator console, or a custom host.
2. Runtime backend and model reference: `codex:*`, `claude:*`, or `pi:<provider>:<model>`.
3. Workspace, identity, and any secondary SOUL/personality document.
4. Skills root and selected skills.
5. Tool and MCP policy, including whether the policy should be fail-closed.
6. Memory mode: disabled, Markdown, journal, graph/search/MCP, and write behavior.
7. Observability and traceability requirements.
8. Deployment constraints, secrets, allowlists, and local-only/public boundary.

If the user says to choose defaults, choose a local-first host: `@mono-agent/config` + `@mono-agent/agent-host` + `@mono-agent/tui`, disabled memory writes, fail-closed tools, JSONL artifacts under `.mono-agent/artifacts`, and no public network bind.

## Composition Workflow

Read `references/package-map.md` before selecting packages for a new host.

1. Define the host contract in user terms: who talks to the agent, where it runs, what it can touch, and what success looks like.
2. Load adapter-neutral config with `@mono-agent/config`.
3. Build a runtime-backed responder with `@mono-agent/agent-host`.
4. Add selected skills through config `context.skillsRoot` and `context.selectedSkills`; keep skill files under `<skillsRoot>/<skill-name>/SKILL.md`.
5. Add memory only if needed. Use `memory-md` or journal/graph/search packages through config and host composition.
6. Convert tool and MCP settings through `@mono-agent/tool-policy`; default to no allowed tools until the user explicitly needs them.
7. Attach one or more adapters or operator surfaces to the structural responder.
8. Register observability when the host needs traceability in the operator console.
9. Verify with package-level checks and at least one real smoke path through the chosen adapter or surface.

## Implementation References

- Read `references/host-blueprint.md` when writing files for a new mono-agent host or documenting how to wire an existing host.
- Read `references/package-map.md` when deciding which packages belong in scope.
- Read `references/discovery-questions.md` when the user has not already answered the setup questions.
- Read `references/validation.md` before claiming the host or documentation is complete.

## Done Criteria

- The user-facing docs or host code explain which package owns each responsibility.
- The setup asks for missing requirements before wiring packages together.
- The selected package path has no circular or hidden adapter/runtime coupling.
- Secrets and local `.env*` files are not committed.
- The verification evidence covers the chosen composition path, not just unrelated package tests.
