# @worklab-ai/tool-policy

Typed tool and MCP policy normalization for Mono Agent hosts.

The default policy is fail-closed: no built-in tools are allowed unless the host config explicitly names them. `toolPolicyToRuntimeOptions()` converts the validated policy into the option names expected by `@worklab-ai/agent-runtime`.
