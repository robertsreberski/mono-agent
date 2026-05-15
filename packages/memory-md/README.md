# @worklab-ai/memory-md

Optional Markdown memory store for Mono Agent hosts.

The package can read a single `memory.md` file or per-conversation Markdown files with capped reads. It only writes through the explicit `appendHostSummary()` host API; it does not let model output silently rewrite durable memory.
