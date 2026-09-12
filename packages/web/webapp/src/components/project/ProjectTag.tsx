import type { ProjectColor } from "../../types";
import { Icon } from "../Icon";

/**
 * Which project a row belongs to, said on the row itself.
 *
 * The same badge the chat header wears above a conversation's title
 * (`ProjectBadge`), standing still: a row and a running card are already one
 * navigation target, so this is a span rather than a second button inside it.
 * It exists because a project's conversations are no longer in the agent's
 * list -- wherever one still appears (Active now, search, the archive shelf)
 * it has to say where it lives.
 */
export function ProjectTag({
  name,
  color = "default",
}: {
  readonly name: string;
  readonly color?: ProjectColor;
}) {
  return (
    <span
      className="project-badge is-static"
      data-project-color={color}
      title={`In project ${name}`}
    >
      <Icon name="folder" size={11} />
      <span>{name}</span>
    </span>
  );
}
