import type { FieldGroup, FieldGroupRegistry } from "./types.js";

/**
 * Identity helper for type inference when hosts define a FieldGroup.
 */
export function defineFieldGroup(group: FieldGroup): FieldGroup {
  return group;
}

/**
 * Built-in core field groups. Populated in commit C3.
 */
export const CORE_FIELD_GROUPS: FieldGroupRegistry = [];
