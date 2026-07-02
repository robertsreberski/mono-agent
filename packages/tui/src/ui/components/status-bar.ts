import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

import { formatTokens, formatUsd } from "../format.js";
import { styles } from "../theme.js";

export interface StatusBarUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

/**
 * Bottom chrome: connection identity on the left, live turn telemetry on the
 * right. Ephemeral text (stream status/hints) overrides the telemetry segment
 * until the next update.
 */
export class StatusBar implements Component {
  private identity = "";
  private model: string | undefined;
  private usage: StatusBarUsage | undefined;
  private cumulativeUsd: number | undefined;
  private providerNote = "";
  private ephemeral = "";
  private hint = "tab views · esc cancel · ctrl+c quit · /help";

  setIdentity(identity: string): void {
    this.identity = identity;
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  setUsage(usage: StatusBarUsage | undefined, cumulativeUsd: number | undefined, model?: string): void {
    if (usage !== undefined) {
      this.usage = usage;
    }
    if (cumulativeUsd !== undefined) {
      this.cumulativeUsd = cumulativeUsd;
    }
    if (model !== undefined) {
      this.model = model;
    }
  }

  setProviderNote(note: string): void {
    this.providerNote = note;
  }

  setEphemeral(text: string): void {
    this.ephemeral = text;
  }

  setHint(hint: string): void {
    this.hint = hint;
  }

  resetTurn(): void {
    this.providerNote = "";
    this.ephemeral = "";
  }

  render(width: number): string[] {
    const segments: string[] = [];
    if (this.identity.length > 0) {
      segments.push(styles.accent(this.identity));
    }
    if (this.model !== undefined && this.model.length > 0) {
      segments.push(styles.muted(this.model));
    }
    if (this.usage !== undefined) {
      const cache = this.usage.cacheRead > 0 ? ` (cache ${formatTokens(this.usage.cacheRead)})` : "";
      segments.push(styles.muted(`↑${formatTokens(this.usage.input)} ↓${formatTokens(this.usage.output)}${cache}`));
    }
    if (this.cumulativeUsd !== undefined && this.cumulativeUsd > 0) {
      segments.push(styles.muted(formatUsd(this.cumulativeUsd)));
    }
    if (this.providerNote.length > 0) {
      segments.push(styles.warning(this.providerNote));
    }
    if (this.ephemeral.length > 0) {
      segments.push(styles.dim(this.ephemeral));
    }
    segments.push(styles.dim(this.hint));
    return ["", ...new Text(segments.join(styles.dim(" · ")), 1, 0).render(width)];
  }

  invalidate(): void {
    // Stateless render.
  }
}
