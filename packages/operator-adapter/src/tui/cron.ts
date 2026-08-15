import {
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
  type ChannelConfigViewSection,
  type CronOperatorHealth,
  type CronOperatorJob,
  type CronOperatorOverview,
  type CronOperatorRun,
  type CronOperatorRunBase,
  type CronOperatorRunDetail,
  type CronOperatorRunPage,
  type CronOperatorRunStatus,
  type CronOperatorRunSummary,
  type CronOperatorRunTrigger,
  type CronOperatorRunTruncatedField,
} from "@mono-agent/agent-contracts";

export {
  MAX_CRON_OPERATOR_RESPONSE_BYTES,
  MAX_CRON_OPERATOR_RUN_PAGE,
  MAX_CRON_OPERATOR_SUMMARY_REPLY_PART_OUTCOMES,
};
export type {
  CronOperatorHealth,
  CronOperatorJob,
  CronOperatorOverview,
  CronOperatorRun,
  CronOperatorRunBase,
  CronOperatorRunDetail,
  CronOperatorRunPage,
  CronOperatorRunStatus,
  CronOperatorRunSummary,
  CronOperatorRunTrigger,
  CronOperatorRunTruncatedField,
};

export type CronOperatorErrorCode =
  | "invalid_request"
  | "not_found"
  | "actions_disabled"
  | "confirmation_invalid"
  | "idempotency_conflict"
  | "replay_expired"
  | "unavailable";

export class CronOperatorError extends Error {
  readonly code: CronOperatorErrorCode;
  readonly status: number;

  constructor(code: CronOperatorErrorCode, message: string, status: number) {
    super(message);
    this.name = "CronOperatorError";
    this.code = code;
    this.status = status;
  }
}

export interface CronOperatorConfirmation {
  readonly token: string;
  readonly expiresAt: string;
  readonly message: string;
}

export type CronOperatorMutationResult<T> =
  | { readonly kind: "confirmation_required"; readonly confirmation: CronOperatorConfirmation }
  | { readonly kind: "completed"; readonly value: T; readonly replayed: boolean };

export interface CronOperatorActionInput {
  readonly idempotencyKey: string;
  readonly confirmationToken?: string;
}

export interface CronOperatorService {
  overview(): CronOperatorOverview | Promise<CronOperatorOverview>;
  runs(input: {
    readonly jobId: string;
    readonly limit: number;
    readonly before?: string;
  }): CronOperatorRunPage | Promise<CronOperatorRunPage>;
  run(input: {
    readonly jobId: string;
    readonly runId: string;
  }): CronOperatorRunDetail | Promise<CronOperatorRunDetail>;
  configView(): ChannelConfigViewSection | Promise<ChannelConfigViewSection>;
  runNow(
    jobId: string,
    input: CronOperatorActionInput,
  ): CronOperatorMutationResult<{ readonly run: CronOperatorRunSummary }> | Promise<CronOperatorMutationResult<{ readonly run: CronOperatorRunSummary }>>;
  setEffectiveEnabled(
    jobId: string,
    enabled: boolean,
    input: CronOperatorActionInput,
  ): CronOperatorMutationResult<{ readonly job: CronOperatorJob }> | Promise<CronOperatorMutationResult<{ readonly job: CronOperatorJob }>>;
}
