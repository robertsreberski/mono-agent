import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import type { ConfigApplyResult } from "../api.js";

export type SaveBarStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "dirty"; readonly count: number }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly apply?: ConfigApplyResult }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "stale"; readonly message: string };

export interface SaveBarProps {
  readonly status: SaveBarStatus;
  readonly onSave: () => void;
  readonly onReset: () => void;
}

export function SaveBar({ status, onSave, onReset }: SaveBarProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky bottom-0 z-10 -mx-1 mt-2 flex flex-col items-stretch justify-between gap-3 rounded-lg border border-border bg-card/85 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-card/65 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 text-sm text-muted-foreground">{renderMessage(status)}</div>
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
        <Button
          variant="ghost"
          size="sm"
          className="w-full sm:w-auto"
          onClick={onReset}
          disabled={status.kind === "saving" || status.kind === "idle"}
        >
          Discard
        </Button>
        <Button
          size="sm"
          className="w-full sm:w-auto"
          onClick={onSave}
          disabled={
            status.kind === "saving" ||
            status.kind === "idle" ||
            status.kind === "saved"
          }
        >
          {status.kind === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function renderMessage(status: SaveBarStatus): React.JSX.Element | string {
  switch (status.kind) {
    case "idle":
      return "All changes saved.";
    case "dirty":
      return `${status.count} unsaved ${status.count === 1 ? "change" : "changes"}.`;
    case "saving":
      return "Saving…";
    case "saved":
      return renderSavedMessage(status.apply);
    case "stale":
      return (
        <Badge variant="warning" aria-label="stale" className="whitespace-normal text-left">
          Config changed elsewhere — {status.message}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" aria-label="error" className="whitespace-normal text-left">
          {status.message}
        </Badge>
      );
    default:
      return "";
  }
}

function renderSavedMessage(apply: ConfigApplyResult | undefined): React.JSX.Element {
  if (apply === undefined) {
    return (
      <Badge variant="success" aria-label="saved">
        Saved
      </Badge>
    );
  }
  if (apply.kind === "applied") {
    return (
      <Badge variant="success" aria-label="saved and applied" className="whitespace-normal text-left">
        Saved and applied
      </Badge>
    );
  }
  if (apply.kind === "waiting_for_config") {
    return (
      <Badge variant="warning" aria-label="saved waiting for config" className="whitespace-normal text-left">
        Saved; waiting for valid config — {apply.message}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" aria-label="saved apply failed" className="whitespace-normal text-left">
      Saved; apply failed — {apply.message}
    </Badge>
  );
}
