---
title: "Manual AI agent context compaction without rewriting history"
description: "Manual AI agent context compaction shrinks the provider transcript, keeps canonical history, advances a revision and fails closed. How PR #1030 does it."
publishDate: 2026-09-23
tags: ["agent-runtime", "context-compaction", "session-recovery", "mono-agent"]
heroImage: ./hero-manual-agent-context-compaction.png
heroAlt: "Generated diagram of manual AI agent context compaction: a long working transcript funnels into a short lime summary above an unchanged conversation record."
heroCaption: "Generated diagram: the provider's shorter working context sits above the unchanged conversation record; it is not a product screenshot."
---

Manual AI agent context compaction should shorten a model's working transcript without deleting the conversation you can inspect later. The key is to compact the idle provider session as a separate transaction, then advance its revision while leaving the canonical chat history intact. That is the design I helped bring into the mono-agent source in [PR #1030](https://github.com/robertsreberski/mono-agent/pull/1030).

I wanted a button in the context-usage dialog, but the button was the easy part. The hard part was answering a less visible question: if an operator compresses a long conversation before the automatic trigger fires, which history gets shorter, which history must stay complete, and what happens if the summary fails halfway through?

## Why manual context compaction needs its own trigger

Before the change, automatic compaction depended on a configured threshold. That is sensible for unattended turns: the runtime decides when the provider context needs help. It is less helpful when I can see that a conversation is getting crowded and want to compact it *now*, before starting the next job. Raising or lowering the global trigger to handle one conversation would move the policy for all conversations. Sending a chat message saying “compact this” would itself create another turn and, depending on the model's answer, could produce prose about compaction rather than change the provider transcript.

[PR #1030](https://github.com/robertsreberski/mono-agent/pull/1030) adds an explicit Compact action for capable agents. It bypasses the automatic trigger, even when automatic compaction is disabled, while keeping the configured summary, keep-recent and safety settings. This distinction matters: **manual** describes when the operation starts, not a separate weaker compaction algorithm. The guarded summary driver in [Pi](https://github.com/earendil-works/pi), the provider-session runtime mono-agent uses, does the actual work. The capability is recorded under `Unreleased` in [CHANGELOG.md](https://github.com/robertsreberski/mono-agent/blob/main/CHANGELOG.md); I am describing the merged implementation, not promising that every installed console has the button today.

## Two histories, and only one is supposed to shrink

A conversation has a canonical host record and a provider working session. The first is what the host keeps as the durable account of the exchange. The second is the context the provider carries into the next turn. If I replace canonical history with a summary, I lose the detail needed for review, recovery and any later reconstruction. If I merely put a summary in the UI without updating the provider session, the next turn still pays for and reasons over the old working transcript.

The new [harness transaction](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-harness/src/harness.ts) follows the same provider-session acquisition path as an ordinary turn. A warm session can be used in place; an unconfirmed or cold session must be refreshed against durable history, and a missing provider session can be seeded from the canonical record. Only the provider working history is summarized. The operation then syncs the provider state and commits an **empty append** to the host record: no chat message is added, but the provider revision advances. The complete canonical conversation is still there for the next cold reconstruction.

That empty append looks odd until you treat the provider revision as a promise. A compacted provider session is no longer the session that corresponded to the old revision, even though no human or assistant wrote a new message. Advancing the revision tells the next turn which provider state it is allowed to resume. Leaving the revision untouched would make an apparently valid warm session ambiguous.

The [runtime documentation](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-runtime/README.md) says manual compaction creates no new user prompt or assistant response. It does make a provider summary request, so promptless does **not** mean free of inference work or cost. The host does not run memory capture for this operation, and its canonical transcript is not rewritten. Those are narrower, testable claims than “the model remembers everything”: a summary can omit details, which is precisely why the full source record remains available.

## When compaction fails, recover from the intact history

A compact operation cannot race a normal turn against the same session. The harness rejects a running or queued conversation as busy, takes a local lease before its first asynchronous step, and uses a durable provider-turn lock as a cross-process backstop. While compaction runs, the console rejects new sends with “Wait for compaction to finish”; it keeps the draft, and queued live input waits. The button itself shows “Compacting…” and is disabled while a turn is running. That combination is deliberate: a visual loading state alone does not prevent two owners from changing the same durable transcript.

Failure is not treated as “probably compacted”. If the summary, session synchronization or commit fails—or the host shuts down mid-operation—the provider session is retired rather than trusted. A later turn can seed a new session from intact canonical history rather than trusting a half-updated one. Even the UI distinguishes a definite server error from a lost connection: a network failure may mean the server finished while the answer was lost, so the client does not assert that compaction did nothing. The source [web service](https://github.com/robertsreberski/mono-agent/blob/main/packages/web/src/service.ts) and [context dialog](https://github.com/robertsreberski/mono-agent/blob/main/packages/web/webapp/src/components/assistant-ui/ContextDisplay.tsx) make those boundaries visible.

This was not just an error-handling diagram. In [the PR's harness tests](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-harness/src/__tests__/harness-sessions.test.ts), four injected faults—summary failure, sync failure, a thrown provider error and canonical commit failure—each leave the stored conversation unchanged. The next turn uses a different provider session and replays the original history. Another test leaves a summary unresolved, disposes the harness, checks that the compaction was aborted and the session invalidated, then starts a new harness that replays the intact record. Those are controlled tests, not measured live-provider savings; they are the concrete cases that made the failure contract reviewable.

There is another refusal worth keeping. A saved provider session belongs to a model. If the selected conversation model no longer matches its durable session, manual compaction returns `model_changed` rather than rotating or silently compacting a different model's state. That costs an opportunity to compress immediately, but a user-initiated maintenance operation should not quietly change the session's model binding. The next ordinary turn handles its normal model selection.

## What the compaction endpoint reports, and what it hides

The operator route advertises `manualCompaction: { version: 1 }` only when its responder supports the method. Clients feature-detect that capability instead of assuming every agent has durable Pi sessions. The endpoint reports bounded status and estimated before/after token counts, or “Nothing to compact”; it does not return the summary text. Busy, unsupported and failed cases remain distinct. You can inspect the [operator adapter contract](https://github.com/robertsreberski/mono-agent/blob/main/packages/operator-adapter/README.md) and the [harness documentation](https://github.com/robertsreberski/mono-agent/blob/main/packages/agent-harness/README.md) for the exact boundaries.

That is a modest UI for a surprisingly consequential transaction. The tests in [PR #1030](https://github.com/robertsreberski/mono-agent/pull/1030) cover busy admission, warm and cold session acquisition, model mismatch, failures during summary/sync/commit, and browser states at phone and desktop widths. They do not establish a live-provider end-to-end result or prove the button works on a particular installation. I would rather say that plainly than turn a mocked boundary test into a rollout claim.

## What I will check before reaching for Compact

Before using it, I would ask three questions:

1. **Is the capability advertised?** Without continuous durable sessions and a fail-closed history store, there is no safe manual transaction here.
2. **Is the conversation idle and on the expected model?** A busy or model-changed result is information, not an invitation to retry blindly.
3. **Did I get a definite result?** Token estimates can tell me whether the working context shrank; a lost response cannot prove which side of the transaction finished.

The canonical transcript remains the recovery anchor either way.

The lesson extends past compaction. When an agent offers an operator a button for changing internal state, the useful feature is not the button. It is the explicit ownership, revision and failure contract behind it. If the working copy can be shortened while the original record survives, I can choose *when* to compact without also choosing to erase my evidence.
