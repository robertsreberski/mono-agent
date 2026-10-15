/**
 * The adapter's single error type. It lives in its own module so that leaf
 * modules (config parsing, markdown jobs, the preflight contract) can raise a
 * `CronAdapterError` without depending on the scheduler.
 */
export type CronAdapterErrorCode = "invalid_config" | "stream_closed";

export interface CronAdapterErrorDetails {
  readonly code?: CronAdapterErrorCode;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class CronAdapterError extends Error {
  readonly code: CronAdapterErrorCode;
  readonly details: CronAdapterErrorDetails;

  constructor(code: CronAdapterErrorCode, message: string, details: CronAdapterErrorDetails = {}) {
    super(message);
    this.name = "CronAdapterError";
    this.code = code;
    this.details = { ...details, code };
  }
}
