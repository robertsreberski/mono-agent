---
title: "Artifact metrics"
sidebar:
  order: 4
---

# Artifact metrics

`mono-agent metrics` aggregates recorded run summary artifacts into operational numbers you can use to prioritize runtime work: status rates, failure-kind rates, latency percentiles, and total plus per-run cost. It is intentionally offline and read-only. It reads only `*.summary.json` files from `artifacts.dir` or an explicit artifact directory; it does not read exporter config, contact Phoenix, reconcile stale runs, or rewrite artifacts. The default report is agent runs only; pass `--include-memory` to add memory-maintenance `mem-*` runs from the `memory/` namespace and legacy mixed directories.

```bash
mono-agent metrics --artifacts ./.mono-agent/artifacts
mono-agent metrics --since 2026-06-01T00:00:00Z --until 2026-06-24T00:00:00Z
mono-agent metrics --by model --json
mono-agent metrics --include-memory --json
```

## Inputs

| Flag | Effect |
| --- | --- |
| `--artifacts <path>` | Read this artifact directory directly. Wins over config-based `artifacts.dir` resolution. |
| `--config <path>` | Use a non-default config file when resolving `artifacts.dir`. |
| `--env-file <path>` | Load env overrides before resolving `MONO_AGENT_ARTIFACT_DIR`. |
| `--since <iso>` | Include only summaries whose `startedAt` is at or after this ISO instant. |
| `--until <iso>` | Include only summaries whose `startedAt` is at or before this ISO instant. |
| `--by model\|channel\|failureKind` | Add grouped buckets after the overall totals. |
| `--include-memory` | Include memory-maintenance summaries in addition to default agent runs. |
| `--json` | Print the full machine-readable metrics report. |

Without a time window, summaries with missing or unparseable `startedAt` are still included. Once `--since` or `--until` is active, those summaries are excluded because they cannot be placed in the window.

## Reported metrics

The overall bucket, and each optional grouped bucket, reports:

| Metric | Meaning |
| --- | --- |
| `totalRuns` | Number of parsed summaries included after the time-window filter. |
| status counts and rates | Counts and rates for `running`, `succeeded`, `failed`, `cancelled`, and `interrupted`, using `totalRuns` as the denominator. |
| failure-kind rates | Counts and rates for summaries that carry a `failureKind`, using `totalRuns` as the denominator. |
| duration percentiles | `p50`, `p90`, `p99`, and `max` from finite `durationMs` values, using linear interpolation. |
| cost | `totalUsd`, `averageUsdPerRun`, and `runsWithCost`. Cost prefers `cost.cumulativeUsd`, then `cost.totalUsd`, then `usage.cost_usd`; non-numeric values are ignored. |

Grouping by `model` uses `summary.model ?? "unknown"`. Grouping by `failureKind` uses `summary.failureKind ?? "none"`. Grouping by `channel` is best-effort until summaries persist a first-class channel field: it derives the channel from the `conversationId` prefix before `:`, with `unknown` as the fallback.

## Relationship to audit and backfill

`metrics` shares the same full-directory summary scan as `audit-runs`, so it is not capped to the newest 50 runs. Use `audit-runs` when you need structural health details such as malformed files, unrecognized statuses, or stale `running` summaries. Use `metrics` when you need aggregate latency, cost, and failure rates across a window.

`backfill` is different: it maps recorded runs into Phoenix traces and can make network calls. `metrics` never exports or posts anything.
