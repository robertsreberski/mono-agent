# @worklab-ai/observability

Run event recording and artifact summaries for Mono Agent hosts.

`createJsonlRunRecorder()` records runtime-like events, redacts obvious secrets, and writes JSONL event artifacts plus compact JSON summaries containing status, duration, usage, provider session id, failure kind, warnings, and diagnostics.
