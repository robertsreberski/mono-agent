import type { SettingsJson } from "@mono-agent/settings/field-groups";
import type {
  RecordedRunDetail,
  RecordedRunListItem,
  TraceRunDetail,
  TraceRunListItem,
  TraceSourceListItem,
} from "@mono-agent/observability";

import type { FieldGroup } from "@mono-agent/settings/field-groups";

export interface ConfigResponse {
  readonly config: SettingsJson;
  readonly version: string;
}

export interface SchemaResponse {
  readonly fieldGroups: readonly FieldGroup[];
}

export type ConfigApplyResult =
  | { readonly kind: "applied"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "waiting_for_config"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "failed"; readonly message: string; readonly transports: readonly string[] };

export interface PutResponse {
  readonly ok: boolean;
  readonly version: string;
  readonly apply?: ConfigApplyResult;
}

export interface ObservabilityRunsResponse {
  readonly enabled: boolean;
  readonly artifactDir?: string;
  readonly runs: readonly RecordedRunListItem[];
  readonly warnings?: readonly string[];
}

export interface ObservabilityRunResponse {
  readonly enabled: boolean;
  readonly artifactDir?: string;
  readonly run?: RecordedRunDetail;
  readonly warnings?: readonly string[];
}

export interface TraceabilityRunsResponse {
  readonly enabled: boolean;
  readonly registryDir?: string;
  readonly sources: readonly TraceSourceListItem[];
  readonly runs: readonly TraceRunListItem[];
  readonly warnings?: readonly string[];
}

export interface TraceabilityRunResponse {
  readonly enabled: boolean;
  readonly registryDir?: string;
  readonly detail?: TraceRunDetail;
  readonly warnings?: readonly string[];
}

export interface PutError {
  readonly kind: "validation" | "stale" | "network" | "unknown";
  readonly message: string;
  readonly currentVersion?: string;
}

export class OperatorConsoleClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private authHeader(): HeadersInit {
    return { Authorization: `Bearer ${this.token}` };
  }

  async fetchSchema(): Promise<SchemaResponse> {
    const response = await fetch(`${this.baseUrl}/api/schema`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchSchema failed: ${response.status}`);
    }
    return (await response.json()) as SchemaResponse;
  }

  async fetchConfig(): Promise<ConfigResponse> {
    const response = await fetch(`${this.baseUrl}/api/config`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchConfig failed: ${response.status}`);
    }
    return (await response.json()) as ConfigResponse;
  }

  async fetchObservedRuns(): Promise<ObservabilityRunsResponse> {
    const response = await fetch(`${this.baseUrl}/api/observability/runs`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchObservedRuns failed: ${response.status}`);
    }
    return (await response.json()) as ObservabilityRunsResponse;
  }

  async fetchObservedRun(runId: string): Promise<ObservabilityRunResponse> {
    const response = await fetch(`${this.baseUrl}/api/observability/runs/${encodeURIComponent(runId)}`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchObservedRun failed: ${response.status}`);
    }
    return (await response.json()) as ObservabilityRunResponse;
  }

  async fetchTraceabilityRuns(): Promise<TraceabilityRunsResponse> {
    const response = await fetch(`${this.baseUrl}/api/traceability/runs`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchTraceabilityRuns failed: ${response.status}`);
    }
    return (await response.json()) as TraceabilityRunsResponse;
  }

  async fetchTraceabilityRun(sourceId: string, runId: string): Promise<TraceabilityRunResponse> {
    const response = await fetch(`${this.baseUrl}/api/traceability/runs/${encodeURIComponent(sourceId)}/${encodeURIComponent(runId)}`, {
      headers: this.authHeader(),
    });
    if (!response.ok) {
      throw new Error(`fetchTraceabilityRun failed: ${response.status}`);
    }
    return (await response.json()) as TraceabilityRunResponse;
  }

  async writeConfig(input: {
    readonly patch: SettingsJson;
    readonly expectedVersion: string;
  }): Promise<PutResponse> {
    const response = await fetch(`${this.baseUrl}/api/config`, {
      method: "PUT",
      headers: { ...this.authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (response.status === 409) {
      const body = (await response.json()) as { error: string; currentVersion: string };
      const err: PutError = { kind: "stale", message: body.error, currentVersion: body.currentVersion };
      throw err;
    }
    if (response.status === 400) {
      const body = (await response.json()) as { error: string; message?: string };
      const err: PutError = { kind: "validation", message: body.message ?? body.error };
      throw err;
    }
    if (!response.ok) {
      const err: PutError = { kind: "unknown", message: `writeConfig failed: ${response.status}` };
      throw err;
    }
    return (await response.json()) as PutResponse;
  }
}
