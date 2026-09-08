import { CodedError } from "@mono-agent/agent-contracts";

export type TuiAdapterErrorCode =
  | "context_import_conflict"
  | "context_import_failed"
  | "context_import_unsupported"
  | "invalid_config"
  | "invalid_request"
  | "missing_required_config"
  | "model_catalog_too_large"
  | "process_job_response_too_large"
  | "unsafe_host"
  | "start_failed";

export interface TuiAdapterErrorDetails {
  readonly code?: TuiAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class TuiAdapterError extends CodedError<TuiAdapterErrorCode> {
  declare readonly details: TuiAdapterErrorDetails;

  constructor(
    code: TuiAdapterErrorCode,
    message: string,
    details: TuiAdapterErrorDetails = {},
  ) {
    super(code, message, details);
  }
}
