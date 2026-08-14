# @mono-agent/advisor-mcp

Expose one bounded external review tool over Streamable HTTP MCP.

## Category

Category: `communication`

Tier: `plugin`

## Responsibility

Serve a long-lived MCP endpoint whose `review_iteration` tool sends bounded,
untrusted review material to the configured mono-agent responder.

## Install / Usage

Install the same lockstep version as `@mono-agent/agent-app`. Detailed client
and channel configuration is documented in the advisor channel guide.

## Architecture

The package owns configuration, continuity metadata, prompt containment, the
review tool, the HTTP listener, and the config-loaded channel lifecycle.

## Public API

The public entrypoint exposes the config loader now and the server and channel
factories once their implementation is connected.

## Dependency Boundary

Depends only on the shared agent contracts plus Express, the MCP SDK, and Zod.

## What This Package Does Not Own

It does not choose a model, tool set, runtime policy, repository path, command,
or caller filesystem context.

## Related Documentation

- [Advisor MCP channel](../../docs/channels/advisor.md)

## Verification

Run the package build, typecheck, tests, and smoke scripts from the workspace
root.
