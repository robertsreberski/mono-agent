import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  loadMonoAgentConfigWithSources,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";

import {
  buildTuiConfigSummary,
  type TuiConfigFieldSource,
  type TuiConfigSummarySection,
} from "../config/pane.js";

export interface ConfigPaneProps {
  readonly configPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly active: boolean;
  readonly logger?: {
    readonly error?: (
      message: string,
      metadata?: Record<string, unknown>,
    ) => void;
  };
}

interface ConfigLoadState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly sections?: readonly TuiConfigSummarySection[];
  readonly errorMessage?: string;
  readonly loadedAt?: number;
}

const SOURCE_LABEL: Record<TuiConfigFieldSource, string> = {
  env: "env",
  json: "json",
  default: "default",
};

const SOURCE_COLOR: Record<TuiConfigFieldSource, string> = {
  env: "green",
  json: "cyan",
  default: "gray",
};

export function ConfigPane({
  configPath,
  cwd,
  env,
  active,
  logger,
}: ConfigPaneProps): React.JSX.Element {
  const [state, setState] = useState<ConfigLoadState>({ status: "idle" });

  const load = useCallback(async () => {
    setState((previous) => ({
      ...previous,
      status: "loading",
    }));
    try {
      const jsonResult = await readMonoAgentConfigJson(configPath);
      const config = await loadMonoAgentConfigWithSources({
        env,
        cwd,
        jsonPath: configPath,
      });
      const redacted = redactMonoAgentConfig(config);
      const sections = buildTuiConfigSummary({
        redacted,
        json: jsonResult.json,
        env,
      });
      setState({
        status: "ready",
        sections,
        loadedAt: Date.now(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.error?.("config.load.failed", { message });
      setState({
        status: "error",
        errorMessage: message,
      });
    }
  }, [configPath, cwd, env, logger]);

  useEffect(() => {
    void load();
  }, [load]);

  useInput(
    (input) => {
      if (input === "r" || input === "R") {
        void load();
      }
    },
    { isActive: active },
  );

  if (state.status === "loading" || state.status === "idle") {
    return (
      <Box paddingX={1}>
        <Text color="gray">loading {configPath}…</Text>
      </Box>
    );
  }

  if (state.status === "error") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">failed to load {configPath}</Text>
        <Text color="gray">{state.errorMessage ?? "unknown error"}</Text>
        <Text color="gray">press r to retry</Text>
      </Box>
    );
  }

  const loadedLabel =
    state.loadedAt === undefined
      ? ""
      : new Date(state.loadedAt).toISOString().replace("T", " ").slice(0, 19);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="gray">
          {configPath} · loaded {loadedLabel} · press r to reload · edits via
          @mono-agent/operator-console
        </Text>
      </Box>
      {state.sections?.map((section) => (
        <Box key={section.heading} flexDirection="column" marginTop={1}>
          <Text bold>{section.heading}</Text>
          {section.fields.map((field) => (
            <Box key={field.label}>
              <Text color="gray">  {field.label.padEnd(18)}</Text>
              <Text>
                {field.value}
                {field.redacted === true ? " (redacted)" : ""}
              </Text>
              <Text color={SOURCE_COLOR[field.source]}>
                {"  ["}
                {SOURCE_LABEL[field.source]}
                {"]"}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
