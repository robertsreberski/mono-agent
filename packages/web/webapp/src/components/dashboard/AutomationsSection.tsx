import { useConsoleStore } from "../../console-store";
import { AutomationsList } from "../AutomationsList";
import { Icon } from "../Icon";

/** The Automations collection, opened in place of Running and Recent. */
export function AutomationsSection({
  query,
  onNavigate,
}: {
  readonly query: string;
  readonly onNavigate?: () => void;
}) {
  const { setNavigationDestination } = useConsoleStore();
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-automations-label">
      <button
        type="button"
        className="collection-back"
        onClick={() => setNavigationDestination("chats")}
      >
        <Icon name="chevron-left" size={15} />
        <span>All conversations</span>
      </button>
      <h2 className="dashboard-section-label" id="dashboard-automations-label">Automations</h2>
      <AutomationsList query={query} onSelect={onNavigate} />
    </section>
  );
}
