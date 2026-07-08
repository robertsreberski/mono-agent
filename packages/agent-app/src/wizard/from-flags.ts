import { defaultAnswers, type WizardAnswers } from "./answers.js";
import { findPreset } from "./presets.js";

/** Channels `mono-agent init --with <csv>` can switch on, by their short flag name. */
export const WITH_CHANNELS = ["telegram", "slack", "webhook", "openaiApi", "cron"] as const;
export type WithChannel = (typeof WITH_CHANNELS)[number];

/** True when `value` is a `--with` channel flag name. */
export function isWithChannel(value: string): value is WithChannel {
  return (WITH_CHANNELS as readonly string[]).includes(value);
}

/** `--with <channel>` flag → the capability-module id that enables it. */
const WITH_CHANNEL_MODULE_ID: Record<WithChannel, string> = {
  telegram: "channel:telegram",
  slack: "channel:slack",
  webhook: "channel:webhook",
  openaiApi: "channel:openai-api",
  cron: "channel:cron",
};

/** The non-interactive `init`/preset flags, before they are mapped onto answers. */
export interface AnswersFromCliArgs {
  readonly model?: string;
  readonly fallbackModels?: readonly string[];
  readonly effort?: string;
  readonly memory?: "lite" | "journal" | "bujo";
  /** Validated `--with` channel flag names (see {@link WithChannel}). */
  readonly withChannels?: readonly string[];
  /** Preset id whose answers seed the base selection (already validated by the caller). */
  readonly presetId?: string;
}

/**
 * Map the non-interactive `init` flags (and an optional preset) onto full wizard
 * answers, running once through the single {@link defaultAnswers} path so
 * `allowedTools` is recomputed from the final capability selection. A preset seeds
 * the base answers (its partial, so it never pins tools); each explicit flag
 * overrides that; `--with` channels are unioned onto the preset/default channels.
 * The caller resolves an unknown `presetId` and errors before calling this.
 */
export function answersFromCli(args: AnswersFromCliArgs): WizardAnswers {
  const basePartial: Partial<WizardAnswers> = args.presetId === undefined
    ? {}
    : findPreset(args.presetId)?.answers ?? {};

  const channels = new Set<string>(basePartial.channels ?? defaultAnswers().channels);
  for (const channel of args.withChannels ?? []) {
    if (isWithChannel(channel)) {
      channels.add(WITH_CHANNEL_MODULE_ID[channel]);
    }
  }

  const memory = args.memory === undefined ? basePartial.memory : `memory:${args.memory}`;

  return defaultAnswers({
    ...basePartial,
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.fallbackModels === undefined ? {} : { fallbackModels: args.fallbackModels }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    channels: [...channels],
    ...(memory === undefined ? {} : { memory }),
  });
}
