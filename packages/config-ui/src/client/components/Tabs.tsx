import { useId } from "react";

export interface TabsProps {
  readonly tabs: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly activeId: string;
  readonly onSelect: (id: string) => void;
}

export function Tabs({ tabs, activeId, onSelect }: TabsProps): React.JSX.Element {
  const groupId = useId();
  return (
    <div role="tablist" aria-label="Configuration sections" className="tabs">
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            id={`${groupId}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${groupId}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={`tabs__tab${selected ? " tabs__tab--active" : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
