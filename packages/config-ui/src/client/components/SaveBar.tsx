import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

export type SaveBarStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "dirty"; readonly count: number }
  | { readonly kind: "saving" }
  | { readonly kind: "saved" }
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
      className="sticky bottom-0 z-10 -mx-1 mt-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-card/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/60"
    >
      <div className="text-sm text-muted-foreground">{renderMessage(status)}</div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={status.kind === "saving" || status.kind === "idle"}
        >
          Discard
        </Button>
        <Button
          size="sm"
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
      return (
        <Badge variant="success" aria-label="saved">
          Saved
        </Badge>
      );
    case "stale":
      return (
        <Badge variant="warning" aria-label="stale">
          Config changed elsewhere — {status.message}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" aria-label="error">
          {status.message}
        </Badge>
      );
    default:
      return "";
  }
}
