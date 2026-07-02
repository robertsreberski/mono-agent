import { Container, Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import {
  loadMonoAgentConfigWithSources,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";

import { buildTuiConfigSummary } from "../../config/pane.js";
import type { TuiConfigFieldSource } from "../../config/pane.js";
import { styles } from "../theme.js";

export interface ConfigViewOptions {
  readonly tui: TUI;
  readonly env: Record<string, string | undefined>;
}

const SOURCE_STYLE: Record<TuiConfigFieldSource, (text: string) => string> = {
  env: styles.success,
  json: styles.accent,
  default: styles.dim,
};

/**
 * Read-only, redacted, source-annotated config view built by the same
 * `buildMonoAgentConfigView` the `mono-agent config` command uses. Reads the
 * agent's config FILE from its manifest path; the env layer shown is this
 * shell's, not the agent process's (stated in the header).
 */
export class ConfigView extends Container {
  private readonly options: ConfigViewOptions;
  private configPath: string | undefined;
  private cwd = process.cwd();

  constructor(options: ConfigViewOptions) {
    super();
    this.options = options;
    this.showMessage(styles.muted("No config path available for the selected agent."));
  }

  handleInput(data: string): void {
    if (data === "r" || data === "R") {
      void this.refresh();
    }
  }

  setConfigPath(configPath: string | undefined, cwd?: string): void {
    this.configPath = configPath;
    if (cwd !== undefined) {
      this.cwd = cwd;
    }
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.configPath === undefined) {
      this.showMessage(styles.muted("No config path available for the selected agent."));
      this.options.tui.requestRender();
      return;
    }
    try {
      const jsonResult = await readMonoAgentConfigJson(this.configPath);
      const config = await loadMonoAgentConfigWithSources({
        env: this.options.env,
        cwd: this.cwd,
        jsonPath: this.configPath,
      });
      const sections = buildTuiConfigSummary({
        redacted: redactMonoAgentConfig(config),
        json: jsonResult.json,
        env: this.options.env,
      });
      this.clear();
      this.addChild(
        new Text(
          `${styles.bold(styles.accent(this.configPath))}\n${styles.dim(
            "read-only · r reload · env overrides shown are from this shell, not the agent process",
          )}`,
          1,
          0,
        ),
      );
      for (const section of sections) {
        const lines = [styles.bold(section.heading)];
        for (const field of section.fields) {
          const source = SOURCE_STYLE[field.source](`[${field.source}]`);
          const value = field.redacted === true ? styles.dim("(redacted)") : field.value;
          lines.push(`  ${styles.muted(field.label)} ${value} ${source}`);
        }
        this.addChild(new Text(lines.join("\n"), 1, 0));
      }
    } catch (error) {
      this.showMessage(styles.error(`Failed to load config: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.options.tui.requestRender();
  }

  private showMessage(text: string): void {
    this.clear();
    this.addChild(new Text(text, 1, 0));
  }
}
