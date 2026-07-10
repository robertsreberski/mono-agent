---
title: "Memory quality benchmark"
sidebar:
  order: 6
---

The repository includes a non-publishable, disposable memory benchmark. Its default suite is deterministic and offline: it creates a temporary SQLite store, uses a deterministic semantic embedding, reports quality and efficiency, then deletes the store.

```bash
pnpm run benchmark:memory
node scripts/memory-benchmark.mjs --json
```

The fast suite covers direct facts, paraphrases, updates/contradictions, temporal questions, recurring noise, alternating queries, exact duplicates, and entity-hop-shaped retrieval. Automatic injection is intentionally limited to canonical direct facts; broad paraphrases, relations, and entity hops remain available to the explicit `MemoryRecall` tool without being synthesized into background context. The unanswerable set separates out-of-domain questions from in-domain **missing-attribute** questions (for example, a person exists in memory but their phone number does not).

Provider-independent contract probes run separately from provider retrieval. Positive probes cover explicit property ownership, direct choice, event date/time, and location. Adversarial probes cover coordinated verbs, ditransitives, reported speech, subordinate wrong objects, inverse relations, and unknown values. Their synthetic scores are never mixed into provider Recall/MRR, latency, context, or false-recall measurements. This keeps raw retrieval quality broad while holding automatic injection to a finite, precision-first contract. The gate is:

- Recall@5 at least 90%
- MRR at least 0.8
- at least 90% of canonical direct-fact probes receive the relevant automatic-recall hit
- 100% of ambiguous-binding probes abstain from automatic injection
- at least 90% of unanswerable cases abstain from automatic injection
- 100% of missing-attribute and out-of-domain cases abstain in the fast suite
- stale recall at most 5%
- false recall at most 5%
- every policy-calibration probe passes

The report also includes Recall@1/8, nDCG@8, informational overall automatic Recall@5/answer coverage, direct-fact automatic coverage, ambiguous-binding abstention, both unanswerable abstention classes, context bytes, indexing/search latency, storage bytes, embedding calls/texts/input tokens/cost, LLM calls/tokens/cost, duplicate ratio, vector coverage, and the benchmark-owned serialized indexing queue's drain time. Search latency uses the same bounded 50-hit backend superset as the shared app retrieval service, then measures automatic recall from its score-and-direct-fact-gated five-hit slice. The direct-fact and ambiguous-binding gates prevent either "inject nothing" or "inject adjacent topic matches" from passing on good raw search ordering alone; overall answer coverage is intentionally not a gate because unsupported or relational answers belong to `MemoryRecall`. Zero LLM cost in the fast suite is literal: the suite never invokes a chat model.

Real providers and larger external suites are explicit opt-ins and are not part of normal CI:

```bash
# Real local embeddings; uses MONO_AGENT_MEMORY_EMBEDDINGS_* overrides when set
node scripts/memory-benchmark.mjs --provider ollama --json

# Download the upstream data separately, then point the adapter at that file
node scripts/memory-benchmark.mjs --suite longmemeval --dataset /path/to/longmemeval.json --provider ollama --json
node scripts/memory-benchmark.mjs --suite locomo --dataset /path/to/locomo.json --provider ollama --json
```

The optional adapters target the upstream [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) datasets. LongMemEval abstention is recognized only from a `question_id` ending in `_abs`; answer-session ids that cannot map to the supplied haystack are rejected. LoCoMo rows with ordinary missing evidence are left unevaluated, while numeric category `5` is deliberately treated as the adversarial/unanswerable class for the retrieval abstention metric. That category-5 treatment differs from standard LoCoMo QA reporting, which commonly excludes those rows. The adapters never download data or contact a provider unless the operator supplies the dataset/provider flags.

Do not point this benchmark at an agent's configured memory path. It intentionally owns and removes only the temporary store it creates.
