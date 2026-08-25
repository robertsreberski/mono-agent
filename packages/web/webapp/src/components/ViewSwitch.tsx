import { useConsoleStore } from "../console-store";
import { Icon } from "./Icon";

export function ViewSwitch({ mobile = false }: { readonly mobile?: boolean }) {
  const { activeView, navigate } = useConsoleStore();
  const entries = [
    { view: "chats" as const, label: "Chats", icon: "threads" as const },
    { view: "board" as const, label: "Board", icon: "archive" as const },
  ];
  return (
    <nav className={mobile ? "tab-bar" : "view-switch"} aria-label="Workspace views">
      {entries.map((entry) => (
        <button
          key={entry.view}
          type="button"
          className={activeView === entry.view ? "is-active" : ""}
          aria-label={entry.label}
          aria-current={activeView === entry.view ? "page" : undefined}
          onClick={() => navigate(entry.view === "board" ? { view: "board" } : { view: "chats" })}
        >
          <Icon name={entry.icon} size={mobile ? 20 : 18} />
          <span>{entry.label}</span>
        </button>
      ))}
    </nav>
  );
}
