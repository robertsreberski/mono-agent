import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleStore } from "../../console-store";
import { Icon } from "../Icon";
import { agentInitials } from "./dashboard-model";

/**
 * Every agent as one 48-pixel square, on one horizontally scrolling line.
 *
 * Selecting an agent deliberately does NOT close the mobile drawer: the
 * operator has chosen where to look, not what to look at, and the list they
 * need next is directly underneath.
 *
 * Pinning is a second, independent action, so it lives behind an explicit
 * per-agent options button rather than a second target inside the square. No
 * long-press: there would be no way to discover it and no way to reach it from
 * a keyboard.
 */
export function AgentStrip() {
  const {
    visibleAgents,
    hiddenOfflineAgentCount,
    selectedAgentId,
    showOfflineAgents,
    selectAgent,
    setAgentPinned,
    setShowOfflineAgents,
  } = useConsoleStore();
  const [openOptions, setOpenOptions] = useState<string | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const closeOptions = useCallback((restoreFocus: boolean) => {
    setOpenOptions(null);
    if (restoreFocus && triggerRef.current?.isConnected) triggerRef.current.focus();
    triggerRef.current = null;
  }, []);

  useEffect(() => {
    if (openOptions === null) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Node && optionsRef.current?.contains(event.target)) return;
      closeOptions(false);
    };
    // CAPTURE, and it stops there: the drawer's own Escape handler is a
    // bubble-phase listener on the same document, and dismissing a popover
    // must not also dismiss the surface it is drawn on.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeOptions(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [closeOptions, openOptions]);

  // An agent that stops being visible takes its popover with it.
  useEffect(() => {
    if (openOptions !== null && !visibleAgents.some((agent) => agent.sourceId === openOptions)) {
      setOpenOptions(null);
    }
  }, [openOptions, visibleAgents]);

  return (
    <nav className="agent-strip" aria-label="Agents">
      <div className="agent-strip-scroll" role="list">
        {visibleAgents.map((agent) => {
          const pinned = Boolean(agent.pinned);
          const selected = selectedAgentId === agent.sourceId;
          const open = openOptions === agent.sourceId;
          return (
            <div className="agent-chip" role="listitem" key={agent.sourceId}>
              <button
                type="button"
                className={`agent-chip-square${selected ? " is-active" : ""}`}
                aria-pressed={selected}
                aria-label={`${agent.label}, ${agent.status}${pinned ? ", pinned" : ""}`}
                title={`${agent.label} · ${agent.status}`}
                onClick={() => selectAgent(agent.sourceId)}
              >
                <span className="agent-chip-initials">{agentInitials(agent.label)}</span>
                <span className={`agent-status is-${agent.status}`} />
                {pinned && <span className="agent-chip-pinned" aria-hidden="true" />}
              </button>
              <span className="agent-chip-label" title={agent.label}>{agent.label}</span>
              <button
                type="button"
                className="agent-chip-more"
                aria-label={`Agent options for ${agent.label}`}
                aria-expanded={open}
                onClick={(event) => {
                  triggerRef.current = event.currentTarget;
                  setOpenOptions(open ? null : agent.sourceId);
                }}
              >
                <Icon name="more" size={13} />
              </button>
              {open && (
                <div className="agent-chip-options" ref={optionsRef}>
                  <button
                    type="button"
                    className={`agent-chip-pin${pinned ? " is-pinned" : ""}`}
                    aria-pressed={pinned}
                    aria-label={`${pinned ? "Unpin" : "Pin"} ${agent.label}`}
                    onClick={() => {
                      void setAgentPinned(agent.sourceId, !pinned).catch(() => {});
                      closeOptions(true);
                    }}
                  >
                    <Icon name="star" size={14} fill={pinned ? "currentColor" : "none"} />
                    <span>{pinned ? "Remove from favorites" : "Add to favorites"}</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {visibleAgents.length === 0 && (
          <p className="agent-strip-empty">
            No agents discovered. Running agents will appear automatically.
          </p>
        )}
      </div>
      {hiddenOfflineAgentCount > 0 && (
        <button
          type="button"
          className={`agent-strip-offline${showOfflineAgents ? " is-active" : ""}`}
          aria-pressed={showOfflineAgents}
          aria-label={showOfflineAgents
            ? "Hide offline agents"
            : `Show ${hiddenOfflineAgentCount} offline agent${hiddenOfflineAgentCount === 1 ? "" : "s"}`}
          title={showOfflineAgents ? "Hide offline agents" : `Show ${hiddenOfflineAgentCount} offline`}
          onClick={() => setShowOfflineAgents(!showOfflineAgents)}
        >
          <Icon name={showOfflineAgents ? "eye-off" : "eye"} size={15} />
          <span className="agent-strip-offline-count">{hiddenOfflineAgentCount}</span>
        </button>
      )}
    </nav>
  );
}
