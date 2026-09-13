import { useAuiState } from "@assistant-ui/react";
import type { ModelTransition, RouteSelection } from "../types";
import { Icon } from "./Icon";
import { effortFullName, effortToken, shortModelName } from "./route-label";

/**
 * A route change is a quiet rule across the transcript, in the same place and
 * at the same rhythm as a membership change: it sits between the turn that ran
 * on the old model and the first turn admitted on the new one.
 *
 * Distinct from a project rule without competing with it: the conversation's
 * own neutral ink rather than a project's colour, a spark rather than a folder,
 * and the two routes either side of an arrow. The short words are the same ones
 * the conversation rows and subagent badges use; the full provider ids and
 * effort names are in the accessible name.
 *
 * What a run ACTUALLY executed with -- a provider fallback, a lowered effort --
 * is not a route change and is not shown here; that stays on the message it
 * happened to, in its run attribution.
 */
const shortRoute = (selection: RouteSelection): string => {
  const model = selection.model === null ? "" : shortModelName(selection.model);
  const effort = selection.effort === null ? "" : effortToken(selection.effort);
  if (model === "") return effort === "" ? "unknown route" : effort;
  return effort === "" ? model : `${model} · ${effort}`;
};

const fullRoute = (selection: RouteSelection): string => {
  const model = selection.model ?? "model not reported";
  return selection.effort === null ? model : `${model}, effort ${effortFullName(selection.effort)}`;
};

export function ModelMarkers({ transitions = [] }: { readonly transitions?: readonly ModelTransition[] }) {
  return <>{transitions.map((transition) => {
    // Same model, different grade: naming the model twice would make the one
    // word that changed the hardest to find.
    const effortOnly = transition.before.model === transition.after.model;
    const grade = (effort: string | null): string => effort === null ? "unknown" : effortToken(effort);
    const label = `${effortOnly ? "Effort" : "Model"} changed from ${fullRoute(transition.before)} to ${fullRoute(transition.after)}`;
    return (
      <div
        key={transition.id}
        className="model-transition"
        role="note"
        aria-label={label}
        title={`${label} · ${new Date(transition.createdAt).toLocaleString()}`}
      >
        <span className="model-transition-label">
          <Icon name="spark" size={11} />
          <span className="model-transition-kind">{effortOnly ? "Effort" : "Model"}</span>
          <span className="model-transition-route">
            {effortOnly ? grade(transition.before.effort) : shortRoute(transition.before)}
          </span>
          <span className="model-transition-arrow" aria-hidden="true">→</span>
          <span className="model-transition-route is-current">
            {effortOnly ? grade(transition.after.effort) : shortRoute(transition.after)}
          </span>
        </span>
      </div>
    );
  })}</>;
}

export function MessageModelMarkers() {
  const transitions = useAuiState((state) => state.message.metadata.custom?.modelTransitions) as readonly ModelTransition[] | undefined;
  return <ModelMarkers transitions={transitions} />;
}
