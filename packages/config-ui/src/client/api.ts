import type { MonoAgentConfigJson } from "@worklab-ai/config";
import type {
  RecordedRunDetail,
  RecordedRunListItem,
} from "@worklab-ai/observability";

import type { FieldGroup } from "../schema/types.js";

export interface ConfigResponse {
  readonly config: MonoAgentConfigJson;
  readonly version: string;
}

export interface SchemaResponse {
  readonly fieldGroups: readonly FieldGroup[];
}

export interface PutResponse {
  readonly ok: boolean;
  readonly version: string;
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

export interface PutError {
  readonly kind: "validation" | "stale" | "network" | "unknown";
  readonly message: string;
  readonly currentVersion?: string;
}

export class ConfigUiClient {
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

  async writeConfig(input: {
    readonly patch: MonoAgentConfigJson;
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
