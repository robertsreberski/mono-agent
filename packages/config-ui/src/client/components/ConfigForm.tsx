import { useCallback, useEffect, useState } from "react";
import type { MonoAgentConfigJson } from "@worklab-ai/config";

import {
  readFieldValue,
  writeFieldValue,
} from "../../schema/field-group.js";
import type { FieldDefinition, FieldGroup } from "../../schema/types.js";
import type { ConfigUiClient, PutError } from "../api.js";
import { FieldGroupCard } from "./FieldGroupCard.js";
import { SaveBar, type SaveBarStatus } from "./SaveBar.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";

export interface ConfigFormProps {
  readonly client: ConfigUiClient;
  /** Optional preloaded data — used by tests to bypass the network. */
  readonly initial?: {
    readonly fieldGroups: readonly FieldGroup[];
    readonly config: MonoAgentConfigJson;
    readonly version: string;
  };
}

export function ConfigForm({ client, initial }: ConfigFormProps): React.JSX.Element {
  const [fieldGroups, setFieldGroups] = useState<readonly FieldGroup[]>(initial?.fieldGroups ?? []);
  const [config, setConfig] = useState<MonoAgentConfigJson>(initial?.config ?? {});
  const [version, setVersion] = useState<string>(initial?.version ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<SaveBarStatus>({ kind: "idle" });
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (initial !== undefined) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [schema, current] = await Promise.all([
          client.fetchSchema(),
          client.fetchConfig(),
        ]);
        if (cancelled) {
          return;
        }
        setFieldGroups(schema.fieldGroups);
        setConfig(current.config);
        setVersion(current.version);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, initial]);

  const draftCount = Object.keys(drafts).length;
  useEffect(() => {
    if (status.kind === "saved" || status.kind === "stale" || status.kind === "error") {
      return;
    }
    setStatus(draftCount === 0 ? { kind: "idle" } : { kind: "dirty", count: draftCount });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCount]);

  const handleChange = useCallback((field: FieldDefinition, next: string) => {
    setStatus((prev) => (prev.kind === "saved" || prev.kind === "error" || prev.kind === "stale" ? { kind: "dirty", count: 0 } : prev));
    setDrafts((prev) => {
      // Strip when the draft equals the persisted value.
      const current = readFieldValue(config, field);
      if (
        (current === undefined && next.trim().length === 0) ||
        (current !== undefined && String(current) === next.trim())
      ) {
        const { [field.id]: _stripped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [field.id]: next };
    });
  }, [config]);

  const handleReset = useCallback(() => {
    setDrafts({});
    setStatus({ kind: "idle" });
  }, []);

  const handleSave = useCallback(async () => {
    setStatus({ kind: "saving" });
    let patch: MonoAgentConfigJson = {};
    try {
      for (const group of fieldGroups) {
        for (const field of group.fields) {
          const draft = drafts[field.id];
          if (draft === undefined) {
            continue;
          }
          patch = writeFieldValue(patch, field, draft);
        }
      }
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const result = await client.writeConfig({ patch, expectedVersion: version });
      setVersion(result.version);
      // Re-fetch so the local config reflects redacted-secret state and merged values.
      try {
        const refreshed = await client.fetchConfig();
        setConfig(refreshed.config);
        setVersion(refreshed.version);
      } catch {
        // best-effort; keep saved state visible
      }
      setDrafts({});
      setStatus({ kind: "saved" });
    } catch (error) {
      const err = error as PutError;
      if (err.kind === "stale") {
        setStatus({ kind: "stale", message: "Reload to fetch the latest values, then re-apply your edits." });
      } else if (err.kind === "validation") {
        setStatus({ kind: "error", message: err.message });
      } else {
        setStatus({ kind: "error", message: err.message ?? "Save failed." });
      }
    }
  }, [client, drafts, fieldGroups, version]);

  if (loadError !== undefined) {
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <h2 className="font-medium text-destructive">Failed to load configuration</h2>
        <p className="mt-1 text-muted-foreground">{loadError}</p>
      </div>
    );
  }

  if (fieldGroups.length === 0) {
    return (
      <div role="status" className="text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <Tabs defaultValue={fieldGroups[0]?.id ?? ""}>
        <TabsList aria-label="Configuration sections">
          {fieldGroups.map((group) => (
            <TabsTrigger key={group.id} value={group.id}>
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {fieldGroups.map((group) => (
          <TabsContent key={group.id} value={group.id} className="pt-2">
            <FieldGroupCard
              group={group}
              config={config}
              drafts={drafts}
              onChange={handleChange}
            />
          </TabsContent>
        ))}
      </Tabs>
      <SaveBar status={status} onSave={handleSave} onReset={handleReset} />
    </div>
  );
}
