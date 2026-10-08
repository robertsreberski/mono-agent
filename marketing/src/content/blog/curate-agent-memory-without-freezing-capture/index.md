---
title: "Curate agent memory without freezing new captures"
description: "Curate agent memory with an operator-approved plan prepared while captures continue; stop the agent only to apply, checking the selected source lines."
publishDate: 2026-09-25
tags: ["agent-memory", "memory-curation", "data-integrity", "mono-agent"]
heroImage: "./hero-curate-agent-memory-without-freezing-capture.png"
heroAlt: "Abstract agent memory curation gate selecting records while other captures keep flowing"
heroCaption: "Generated conceptual artwork: selected records pass through a sorting gate while the capture stream continues; this is not a product screenshot."
---

To curate agent memory without freezing new captures, I prepare a private plan while captures continue, have an operator accept specific proposals, and stop the agent only for apply. At apply I check the selected source lines, not the whole preparation snapshot. This is one-time operator maintenance, not automatic repair.

## Why a whole-store fingerprint blocked memory curation on a live agent

The first `apply` would refuse any plan if one unrelated memory had been captured since `prepare`. The canonical memory store had to have exactly its preparation fingerprint. Meanwhile, preparation asks a model to examine batches of lines. A live agent still capturing completed turns changes that fingerprint before the operator has finished reviewing the plan. The result was a choice between stopping captures for the entire preparation period and preparing the plan again.

The [follow-up in PR #1067](https://github.com/robertsreberski/mono-agent/pull/1067) records a dry run against an older store of about 4,000 lines: roughly 340 model calls, taking hours. The dry run did not demonstrate a stale-fingerprint refusal; it exposed how long the whole-store freshness window would remain open. It also exposed a line limit below the corpus and a legacy self-relation that blocked the safety check. I had made *no changes after the snapshot* synonymous with *the chosen changes are still safe*. Those conditions are different.

A long-lived memory store collects useful facts alongside stale summaries, generic advice, and duplicate entities. Curation should let the operator inspect bounded suggestions, decline destructive ones, and make accepted changes under the same durability rules as other memory maintenance. [PR #1066](https://github.com/robertsreberski/mono-agent/pull/1066) added that one-time workflow to [BuJo (Bullet Journal) memory](https://docs.mono-agent.dev/memory/): `prepare`, `review`, `apply`, and `restore`.

I had made *no changes after the snapshot* synonymous with *the chosen changes are still safe*. Those conditions are different.

## Operator-approved curation plans, not automatic memory repair

The first design choice remains worth keeping. `prepare` reads canonical memory, selects a bounded set of lines and gives the model context only from that store. By default it selects up to 120 lines; the ceiling is now 8,192, sent in batches of 12. Its `--dry-run` estimates model calls and tokens without writing a plan or making model calls. The real run writes an owner-private plan, including source bindings and proposals, outside the memory root. The plan contains memory text, so I treat it as private data rather than a shareable artifact.

Each suggested keep, drop, rewrite, label or same-type entity merge starts unaccepted. `review` can accept or reject categories, and a specific rejection wins over a broad acceptance. A checksum catches edits to the proposals while allowing acceptance choices to change. That checksum catches accidental edits; the operator still decides which changes are appropriate. The model cannot authorize attribution to the user, fabricate a verified lesson, or turn a weak legacy summary into a fact with stronger provenance. Individually invalid suggestions are discarded rather than given a free pass because other suggestions in the batch looked plausible.

This is why I would not describe the feature as automatic memory repair. The model suggests; the operator reviews; the host validates; only a stopped-store `apply` mutates. The [documented CLI sequence](https://docs.mono-agent.dev/memory/validation-and-cli/) makes that boundary explicit. It also documents that `restore` is available only while the post-apply tree has not changed. The exact-tree condition matters after another capture or maintenance action changes the store.

## Pin the lines being edited, not every unrelated capture

[PR #1067](https://github.com/robertsreberski/mono-agent/pull/1067) changed the freshness rule. The preparation fingerprint still identifies the snapshot from which proposals came. At apply, the selected source of each accepted proposal must still be at its original file and line, with the same ID, text, creation date, references and status. A changed selected line fails before backup. An unrelated capture or status change elsewhere does not make that proposal stale; lines added after preparation simply are not part of its plan.

That is a narrower claim than "apply is safe despite any concurrent change." The agent must still be stopped for apply, and the writer lease still fences mutations. Entity merges are checked against the *current* graph, not just the graph the model saw hours earlier. Only a merge that **creates** a self-relation is rejected; a self-relation already in a legacy graph does not make every unrelated operation impossible. The current canonical fingerprint, not the old preparation fingerprint, binds the backup and the root-swap transaction. Changed accepted source lines still refuse the operation before it touches the store.

This division matters when the source corpus keeps moving. Preparation can run while new memories arrive. Review can take human time. The short maintenance boundary begins when the operator stops the agent and applies the accepted plan; it is not stretched across all model calls and deliberation. It does not remove the need for a quiet, verified apply. It moves the unavoidable quiet period to the step that actually writes.

The code behind those checks is public: [`curate.ts`](https://github.com/robertsreberski/mono-agent/blob/e641d768deaf09b407a7390082ef966d3d0172f1/packages/memory/src/bujo/curate.ts) binds proposed lines and checks their current sources; [`explicit-curate.ts`](https://github.com/robertsreberski/mono-agent/blob/e641d768deaf09b407a7390082ef966d3d0172f1/packages/memory/src/bujo/explicit-curate.ts) coordinates the reviewed plan and durable apply. Those are inspection points for the distinction between a preparation fingerprint and an apply-time fingerprint.

## Selection limits and legacy self-relations in memory curation

A selective freshness check would not have made the dry run practical by itself. The original 4,096-line selection ceiling was smaller than the observed corpus, so the follow-up raised it to 8,192 and bounded the private plan to 16 MiB. A dry run and a smaller selection make the expected call volume visible before committing to it.

The existing self-relation was a different class of problem. Rejecting every graph that already contains one would prevent repair precisely where maintenance is needed. The revised check compares the relationship across the proposed merge: if the merge would collapse two endpoints onto the same entity, reject that merge. The legacy self-relation stays as it is; it no longer blocks unrelated merges. Keeping this rule separate from the freshness rule made it possible to explain which safety property each failure actually guarded.

The follow-up also distinguishes safe preparation/review diagnostics from errors that might contain memory text. A failure message is not harmless just because it happens before mutation. The CLI reports only a fixed set of content-free reasons and leaves other errors generic.

## What I would check before using this on a live store

I would first ask whether the cleanup is worth its call volume and whether the suggested categories have been read, not just accepted en masse. The private plan may include the very data being cleaned, and model preparation can use the configured memory LLM or an explicit model override. A `--dry-run` provides a call and token estimate; monetary cost is unknown unless a trustworthy price is available. The operator should account for where that model processes the content and keep the plan private.

My operator checklist is short:

1. Run `--dry-run` to gauge call volume, then `prepare` and inspect the private plan.
2. Use `review` to accept only supported proposals. Plans made before the status-pinned-source change need preparation again.
3. Stop the configured agent, apply under the maintenance fence, and inspect the backup and health/parity outcome. A changed selected source calls for a new plan; unrelated new records do not.

The PRs test stale selected lines, unrelated appends, legacy graph relations, bounds and recovery. They do not establish an unattended live-store rollout. The code described here is on `main` as of [commit e641d768](https://github.com/robertsreberski/mono-agent/commit/e641d768deaf09b407a7390082ef966d3d0172f1); installed agents need their own update.

The general lesson I take from this work is not "relax stale-plan checks." It is to state precisely *what a plan intends to change*, then validate that intent against the current world at the point of mutation. Whole-store equality made the first implementation easy to reason about and hard to use. Source-pinned checks kept the refusal where it matters without turning normal capture into a reason to start a multi-hour review over again.
