import type { Response } from "express";

/** After host acceptance, response lifetime cannot revoke the restart. */
export function scheduleRestartStop(response: Pick<Response, "once">, beginStop: () => void): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    clearTimeout(timer);
    beginStop();
  };
  const timer = setTimeout(fire, 1000);
  response.once("finish", fire);
}
