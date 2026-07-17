"use client";

import { Popover } from "@base-ui/react/popover";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";

/**
 * Controlled adaptation of assistant-ui's Context Display registry component:
 * https://r.assistant-ui.com/base/context-display.json
 *
 * The registry component reads AI SDK state and opens a tooltip. The web
 * console already owns its telemetry, so this version accepts that state as
 * props and uses a click-open Base UI popover.
 */

export interface ContextDisplayUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cost?: number;
}

export interface ContextDisplayProps {
  readonly usage?: ContextDisplayUsage;
  readonly contextWindow?: number;
  readonly className?: string;
}

interface ContextSegment {
  readonly key: Exclude<keyof ContextDisplayUsage, "cost">;
  readonly label: string;
  readonly tokens: number;
}

const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  }
  return String(tokens);
};

const formatUsd = (cost: number): string => {
  const precision = cost > 0 && cost < 0.01 ? 4 : 2;
  return `$${cost.toFixed(precision)}`;
};

const tokenCount = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;

const knownCost = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const knownContextWindow = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : undefined;
};

const joinClassNames = (...values: Array<string | undefined>): string =>
  values.filter((value): value is string => Boolean(value)).join(" ");

const usageSegments = (usage: ContextDisplayUsage | undefined): ContextSegment[] => {
  const segments: ContextSegment[] = [
    { key: "input", label: "Input", tokens: tokenCount(usage?.input) },
    {
      key: "cachedInput",
      label: "Cache read",
      tokens: tokenCount(usage?.cachedInput),
    },
    {
      key: "cacheCreation",
      label: "Cache write",
      tokens: tokenCount(usage?.cacheCreation),
    },
    { key: "output", label: "Output", tokens: tokenCount(usage?.output) },
    {
      key: "reasoning",
      label: "Reasoning",
      tokens: tokenCount(usage?.reasoning),
    },
  ];
  return segments.filter((segment) => segment.tokens > 0);
};

export function ContextDisplay({
  usage,
  contextWindow,
  className,
}: ContextDisplayProps) {
  const segments = usageSegments(usage);
  // Cache read/write are prompt-detail subsets and reasoning is an output-detail
  // subset in mono-agent's canonical usage mapping. Keep each visible without
  // adding any of them to the model's input + output total.
  const totalTokens = tokenCount(usage?.input) +
    tokenCount(usage?.output);
  const cost = knownCost(usage?.cost);
  const windowTokens = knownContextWindow(contextWindow);
  const percent = windowTokens === undefined
    ? undefined
    : Math.min((totalTokens / windowTokens) * 100, 100);
  const roundedPercent = percent === undefined ? undefined : Math.round(percent);
  const triggerSummary = [
    `${formatTokenCount(totalTokens)} tokens`,
    ...(roundedPercent === undefined ? [] : [`${roundedPercent}%`]),
    ...(cost === undefined ? [] : [formatUsd(cost)]),
  ].join(", ");

  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        className={joinClassNames("context-display-trigger", className)}
        data-slot="context-display-trigger"
        aria-label={`Context usage: ${triggerSummary}`}
      >
        <Icon name="spark" size={14} className="context-display-icon" />
        <span className="context-display-trigger-tokens" data-slot="context-display-total">
          {formatTokenCount(totalTokens)} tokens
        </span>
        {roundedPercent !== undefined && (
          <span
            className="context-display-trigger-percent"
            data-slot="context-display-percent"
          >
            {roundedPercent}%
          </span>
        )}
        {cost !== undefined && (
          <span className="context-display-trigger-cost" data-slot="context-display-cost">
            {formatUsd(cost)}
          </span>
        )}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Positioner
          className="context-display-positioner"
          data-slot="context-display-positioner"
          side="bottom"
          align="end"
          sideOffset={8}
        >
          <Popover.Popup
            className="context-display-popover"
            data-slot="context-display-popover"
          >
            <Popover.Title
              className="context-display-title"
              data-slot="context-display-title"
            >
              Context usage
            </Popover.Title>

            {windowTokens !== undefined && percent !== undefined && roundedPercent !== undefined && (
              <section
                className="context-display-window"
                data-slot="context-display-window"
                aria-label="Context window usage"
              >
                <div className="context-display-window-summary">
                  <span>{formatTokenCount(totalTokens)} of {formatTokenCount(windowTokens)} tokens</span>
                  <span className="context-display-percent">{roundedPercent}%</span>
                </div>
                <div
                  className="context-display-progress"
                  data-slot="context-display-progress"
                  role="progressbar"
                  aria-label="Context window used"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Number(percent.toFixed(1))}
                  aria-valuetext={`${formatTokenCount(totalTokens)} of ${formatTokenCount(windowTokens)} tokens (${roundedPercent}%)`}
                >
                  <span
                    className="context-display-progress-value"
                    data-slot="context-display-progress-value"
                    style={{ width: `${percent}%` } as CSSProperties}
                  />
                </div>
              </section>
            )}

            <dl className="context-display-breakdown" data-slot="context-display-breakdown">
              {segments.map((segment) => (
                <div
                  className="context-display-breakdown-row"
                  data-slot="context-display-breakdown-row"
                  data-segment={segment.key}
                  key={segment.key}
                >
                  <dt>{segment.label}</dt>
                  <dd>{formatTokenCount(segment.tokens)}</dd>
                </div>
              ))}
              <div
                className="context-display-breakdown-row context-display-breakdown-total"
                data-slot="context-display-breakdown-total"
              >
                <dt>Total</dt>
                <dd>{formatTokenCount(totalTokens)}</dd>
              </div>
              {cost !== undefined && (
                <div
                  className="context-display-breakdown-row context-display-breakdown-cost"
                  data-slot="context-display-breakdown-cost"
                >
                  <dt>Cost</dt>
                  <dd>{formatUsd(cost)}</dd>
                </div>
              )}
            </dl>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
