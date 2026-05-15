# @worklab-ai/runtime-adapter

Typed Mono Agent facade over `@worklab-ai/agent-runtime`.

This package centralizes the JavaScript-first runtime boundary so other Mono Agent packages can depend on explicit TypeScript contracts instead of importing runtime internals directly. It parses model references, validates execution-mode compatibility, and delegates provider/tool execution to `@worklab-ai/agent-runtime` without replacing it.

```ts
import {
  createMonoRuntime,
  parseMonoRuntimeModelReference,
} from "@worklab-ai/runtime-adapter";

const runtime = createMonoRuntime({ workspace: process.cwd() });
const model = parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5");

const result = await runtime.run("You are concise.", {
  model,
  executionMode: "sdk",
  messages: [{ role: "user", content: "Hello" }],
  abortSignal: new AbortController().signal,
});
```

Runtime failures are not swallowed. If the underlying runtime returns `error`, `failureKind`, or `cancelled`, callers receive that result and must handle it explicitly.
