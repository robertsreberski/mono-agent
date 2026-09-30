// Resolved by AuthGate before any console provider mounts. Legacy mode remains
// the default for isolated component consumers (tests and Storybook).
let multiUser = false;
export const isMultiUser = (): boolean => multiUser;
export const setMultiUser = (enabled: boolean): void => { multiUser = enabled; };
export const AUTH_INVALIDATED = "mono-agent:auth-invalidated";
export const AUTH_RECHECK = "mono-agent:auth-recheck";
export const invalidateAuthentication = (): void => {
  if (multiUser) window.dispatchEvent(new Event(AUTH_INVALIDATED));
};
export const recheckAuthentication = (): void => {
  if (multiUser) window.dispatchEvent(new Event(AUTH_RECHECK));
};
