# @worklab-ai/agent-harness

Composable request-to-runtime harness for Mono Agent hosts.

The harness owns the framework spine that should not live in communication adapters or demos:

- loads identity/SOUL files through `@worklab-ai/context`;
- optionally loads Markdown memory and recent conversation history;
- activates configured skills with full `SKILL.md` bodies;
- applies fail-closed tool policy to runtime run options;
- passes parsed runtime model references to a `@worklab-ai/runtime-adapter` compatible runtime;
- records runtime events through an observability recorder; and
- returns explicit failure objects instead of converting runtime/provider failures into success text.

`createAgentResponder()` adapts the harness to the structural responder shape used by `@worklab-ai/telegram-bridge` without making Telegram a core dependency.
