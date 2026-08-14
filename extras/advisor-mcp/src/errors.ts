export type AdvisorErrorCode =
  | "invalid_config"
  | "missing_required_config"
  | "unsafe_host"
  | "listen_failed"
  | "no_address";

export interface AdvisorErrorDetails {
  readonly code?: AdvisorErrorCode;
  readonly [key: string]: unknown;
}

export class AdvisorError extends Error {
  readonly code: AdvisorErrorCode;
  readonly details: AdvisorErrorDetails;

  constructor(
    code: AdvisorErrorCode,
    message: string,
    details: AdvisorErrorDetails = {},
  ) {
    super(message);
    this.name = "AdvisorError";
    this.code = code;
    this.details = { ...details, code };
  }
}
