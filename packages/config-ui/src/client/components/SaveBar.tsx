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
    <div className="savebar" role="status" aria-live="polite">
      <div className="savebar__message">
        {renderMessage(status)}
      </div>
      <div className="savebar__actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={onReset}
          disabled={status.kind === "saving" || status.kind === "idle"}
        >
          Discard
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={onSave}
          disabled={
            status.kind === "saving" ||
            status.kind === "idle" ||
            status.kind === "saved"
          }
        >
          {status.kind === "saving" ? "Saving…" : "Save"}
        </button>
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
      return "Saved.";
    case "stale":
      return (
        <span className="savebar__stale">Config was changed elsewhere. {status.message}</span>
      );
    case "error":
      return <span className="savebar__error">{status.message}</span>;
    default:
      return "";
  }
}
