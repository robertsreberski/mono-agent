import { CodedError } from "@mono-agent/agent-contracts";

export type LiveAdapterErrorCode =
  | "invalid_config"
  | "unsafe_host"
  | "start_failed";

export interface LiveAdapterErrorDetails {
  readonly code?: LiveAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class LiveAdapterError extends CodedError<LiveAdapterErrorCode> {
  declare readonly details: LiveAdapterErrorDetails;

  constructor(
    code: LiveAdapterErrorCode,
    message: string,
    details: LiveAdapterErrorDetails = {},
  ) {
    super(code, message, details);
  }
}
