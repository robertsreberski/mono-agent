import { CronExpressionParser } from "cron-parser";

const DEFAULT_TIMEZONE = "UTC";

export interface CronExpressionValidationOptions {
  readonly currentDate?: Date;
  readonly timezone?: string;
}

export type CronExpressionValidationResult =
  | {
      readonly ok: true;
      readonly nextDate: Date;
    }
  | {
      readonly ok: false;
      readonly code: "required";
    }
  | {
      readonly ok: false;
      readonly code: "field_count";
      readonly fieldCount: number;
    }
  | {
      readonly ok: false;
      readonly code: "invalid";
      readonly reason: string;
    };

/**
 * Validate a five-field cron expression using the same parser and options as
 * the runtime scheduler, and calculate its next future occurrence.
 */
export function validateCronExpression(
  expression: string | undefined,
  options: CronExpressionValidationOptions = {},
): CronExpressionValidationResult {
  const normalized = expression?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return { ok: false, code: "required" };
  }

  const fields = normalized.split(/\s+/u);
  if (fields.length !== 5) {
    return { ok: false, code: "field_count", fieldCount: fields.length };
  }

  try {
    const nextDate = CronExpressionParser.parse(normalized, {
      currentDate: options.currentDate ?? new Date(),
      strict: false,
      tz: options.timezone ?? DEFAULT_TIMEZONE,
    }).next().toDate();
    return { ok: true, nextDate };
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
