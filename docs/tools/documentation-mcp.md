---
title: "Documentation MCP companion"
sidebar:
  order: 3
---

# Documentation MCP companion

`@mono-agent/docs-mcp` gives an AI coding harness one read-only tool for
searching the version-matched mono-agent documentation and the authoritative
`mono-agent-composer` references. It returns complete Markdown excerpts, not a
list of website links, so the composer can answer configuration and capability
questions from the documented contract instead of searching package source.

This is primarily an **authoring-harness companion** for Codex and Claude Code.
It is not injected into agents created by mono-agent, and it does not change an
agent's `tools.mcpConfigPath` or `mcp.json`.

## Install it with the composer

The normal installer copies the composer skill and pairs the exact same
mono-agent version of the documentation server with every selected harness CLI
that is available:

```bash
mono-agent install-skill
mono-agent install-skill --target codex
mono-agent install-skill --target claude --force
```

The pairing is transactional with the skill install. An existing matching entry
is left alone; an older entry recognized as mono-agent-managed is upgraded. An
unrelated server using the reserved `mono-agent-docs` name is never overwritten,
even with `--force`. If one selected harness CLI is missing, the available target
is configured and the CLI prints the exact manual command for the missing one. If
none of the selected harness CLIs is available, nothing is changed.

Use `--no-docs-mcp` when you intentionally want only the composer files:

```bash
mono-agent install-skill --no-docs-mcp
```

Project-skill maintenance (`--project --check` and `--project --update`) never
changes harness MCP configuration. Start a new Codex or Claude Code session after
installation so it discovers both the skill and server.

## Manual registration

Use the version matching the installed `@mono-agent/agent-app` package:

```bash
MONO_AGENT_VERSION="$(mono-agent --version)"
MONO_AGENT_VERSION="${MONO_AGENT_VERSION#mono-agent }"
codex mcp add mono-agent-docs -- npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION"
claude mcp add --scope user mono-agent-docs -- npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION"
```

The exact version matters: the package contains a prebuilt documentation corpus,
so pairing different versions can give the composer contracts that do not match
the CLI it is configuring.

You can also attach the server to a mono-agent runtime explicitly. This is
separate from the authoring-harness pairing:

```json
{
  "mcpServers": {
    "mono-agent-docs": {
      "command": "npx",
      "args": ["-y", "@mono-agent/docs-mcp@<matching-version>"]
    }
  }
}
```

Point `tools.mcpConfigPath` at that file as described in [MCP servers](/tools/mcp/).

## Tool contract

The server exposes `search_mono_agent_docs`:

| Input | Contract |
| --- | --- |
| `query` | Required natural-language question or exact config, CLI, environment, or package identifier; 3–500 characters. |
| `limit` | Optional result count from 1–8; default `5`. |
| `scope` | `all` (default), `composer`, or `docs`. Use `composer` for configuration and capability questions. |

Every response reports schema `mono-agent.docs-search.v1`, the documentation
version, corpus digest, retrieval mode, and ranked results. Each result includes
its stable chunk id, source, logical path, title, heading path, complete Markdown
text, and a canonical website URL when the source is public documentation. The
same excerpt is readable through
`mono-agent-docs://chunk/{chunkId}` as `text/markdown`.

The tool declares itself read-only, idempotent, non-destructive, and closed-world.

## What is searched

The published corpus is built from two versioned sources:

- public pages under `docs/`, excluding internal skill/process material; and
- the bundled `mono-agent-composer` skill plus its authoritative references.

Markdown is split deterministically by heading and block boundaries. The package
ships those chunks with precomputed local Potion Base 8M embeddings. At query
time it combines local semantic similarity with exact-token BM25 ranking through
reciprocal-rank fusion, retains complete excerpts, removes duplicates, and limits
one source file from crowding out the rest. Exact identifiers such as
`channels.plugins[]`, `MONO_AGENT_MCP_CONFIG_PATH`, and package names therefore
remain searchable alongside natural-language questions.

No website crawl, provider API, model download, filesystem write, or telemetry is
performed while the server runs. Corpus metadata, artifact checksums, dimensions,
and finite vector values are validated before search; corrupt or mismatched
artifacts fail closed.

## Diagnostics

Run the published executable directly when checking an installation:

```bash
MONO_AGENT_VERSION="$(mono-agent --version)"
MONO_AGENT_VERSION="${MONO_AGENT_VERSION#mono-agent }"
npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION" --version
npx -y "@mono-agent/docs-mcp@$MONO_AGENT_VERSION" --check
```

`--version` prints the package, docs, corpus, and embedding-model identities as
JSON. `--check` validates the bundled corpus and performs a representative
composer-scoped search. With no flag, stdout is reserved for MCP stdio protocol
messages; startup or validation failures are written to stderr and exit nonzero.
