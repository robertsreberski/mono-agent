#!/usr/bin/env node

/**
 * The standalone `memory-bujo` CLI was removed. Memory operations now run through
 * `mono-agent memory <subcommand>` from the agent folder, which resolves the
 * configured store, tiers, and embeddings for the operator.
 *
 * This bin ships only as an error-deflector so an old invocation fails loudly
 * (exit 1) instead of silently doing nothing. The BuJo library under `src/bujo/`
 * is unaffected — only this CLI entry point is stubbed.
 */
process.stderr.write(
  "the memory-bujo command was removed; use `mono-agent memory <subcommand>` from the agent folder\n",
);
process.exit(1);
