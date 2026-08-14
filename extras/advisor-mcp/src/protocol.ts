import { createHash } from "node:crypto";

import * as z from "zod/v4";

import type { AdvisorConfig, AdvisorEffort } from "./config.js";

export const REVIEW_ITERATION_TOOL_NAME = "review_iteration";
export const ADVISOR_RESPONSE_SCHEMA = "mono-agent.advisor.v1";

export const ADVISOR_SESSION_KEY_MAX_CHARS = 512;
export const ADVISOR_SESSION_KEY_MAX_BYTES = 2_048;
export const ADVISOR_METADATA_MAX_ENTRIES = 32;
export const ADVISOR_METADATA_KEY_MAX_CHARS = 64;
export const ADVISOR_METADATA_STRING_MAX_CHARS = 2_048;
export const ADVISOR_METADATA_ARRAY_MAX_ITEMS = 16;
export const ADVISOR_METADATA_ARRAY_ITEM_MAX_CHARS = 512;

export const ADVISOR_RESULT_CODES = [
  "ok",
  "advisor_busy",
  "advisor_cancelled",
  "advisor_cleanup_failed",
  "advisor_empty_output",
  "advisor_run_failed",
  "advisor_run_invalid",
  "advisor_run_start_failed",
  "advisor_shutdown",
  "advisor_timeout",
] as const;

export type AdvisorResultCode = (typeof ADVISOR_RESULT_CODES)[number];
export type AdvisorResultStatus = "succeeded" | "failed" | "busy" | "cancelled" | "timed_out";
export type AdvisorMetadataValue = string | number | boolean | readonly string[];
export type AdvisorMetadata = Readonly<Record<string, AdvisorMetadataValue>>;

export interface ReviewIterationInput {
  readonly session_key: string;
  readonly intent: string;
  readonly patch: string;
  readonly verification?: string;
  readonly metadata?: AdvisorMetadata;
}

export interface AdvisorResponseError {
  readonly code: Exclude<AdvisorResultCode, "ok">;
  readonly message: string;
}

export interface AdvisorReviewResponse {
  readonly schema: typeof ADVISOR_RESPONSE_SCHEMA;
  readonly status: AdvisorResultStatus;
  readonly code: AdvisorResultCode;
  readonly continuity_id: string;
  readonly model: string;
  readonly effort: AdvisorEffort;
  readonly review?: string;
  readonly truncated?: boolean;
  readonly error?: AdvisorResponseError;
}

const metadataKeySchema = z.string()
  .min(1)
  .max(ADVISOR_METADATA_KEY_MAX_CHARS)
  .regex(/^[A-Za-z0-9_.:-]+$/u, "metadata keys may contain only letters, digits, dot, underscore, colon, and hyphen");
const metadataStringSchema = z.string().max(ADVISOR_METADATA_STRING_MAX_CHARS);
const metadataValueSchema = z.union([
  metadataStringSchema,
  z.number().finite().min(-1_000_000_000_000_000).max(1_000_000_000_000_000),
  z.boolean(),
  z.array(z.string().max(ADVISOR_METADATA_ARRAY_ITEM_MAX_CHARS)).max(ADVISOR_METADATA_ARRAY_MAX_ITEMS),
]);
const metadataSchema = z.record(metadataKeySchema, metadataValueSchema).superRefine((value, context) => {
  if (Object.keys(value).length > ADVISOR_METADATA_MAX_ENTRIES) {
    context.addIssue({
      code: "custom",
      message: `metadata may contain at most ${ADVISOR_METADATA_MAX_ENTRIES} entries`,
    });
  }
});

export function createReviewIterationInputSchema(config: AdvisorConfig) {
  return z.object({
    session_key: z.string()
      .min(1)
      .max(ADVISOR_SESSION_KEY_MAX_CHARS)
      .superRefine((value, context) => {
        try {
          normalizeAdvisorSessionKey(value);
        } catch (error) {
          context.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "session_key is invalid",
          });
        }
      }),
    intent: z.string().min(1).max(config.maxIntentChars),
    patch: z.string().min(1).max(config.maxPatchChars),
    verification: z.string().max(config.maxVerificationChars).optional(),
    metadata: metadataSchema.optional(),
  }).strict().superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > config.maxRequestBytes) {
      context.addIssue({
        code: "custom",
        message: `review_iteration arguments exceed the ${config.maxRequestBytes}-byte payload ceiling`,
      });
    }
  });
}

export function createAdvisorOutputSchema(config: AdvisorConfig) {
  return z.object({
    schema: z.literal(ADVISOR_RESPONSE_SCHEMA),
    status: z.enum(["succeeded", "failed", "busy", "cancelled", "timed_out"]),
    code: z.enum(ADVISOR_RESULT_CODES),
    continuity_id: z.string().regex(/^advisor:[0-9a-f]{32}$/u),
    model: z.string().min(1).max(512),
    effort: z.enum(configuredEfforts()),
    review: z.string().max(config.maxOutputChars).optional(),
    truncated: z.boolean().optional(),
    error: z.object({
      code: z.enum(ADVISOR_RESULT_CODES.filter((code) => code !== "ok")),
      message: z.string().min(1).max(512),
    }).strict().optional(),
  }).strict();
}

export function normalizeAdvisorSessionKey(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("session_key must be a string");
  }
  if (value.length > ADVISOR_SESSION_KEY_MAX_CHARS
    || Buffer.byteLength(value, "utf8") > ADVISOR_SESSION_KEY_MAX_BYTES) {
    throw new TypeError(
      `session_key must contain at most ${ADVISOR_SESSION_KEY_MAX_CHARS} characters and ${ADVISOR_SESSION_KEY_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) {
    throw new TypeError("session_key must contain visible text");
  }
  if (normalized.length > ADVISOR_SESSION_KEY_MAX_CHARS
    || Buffer.byteLength(normalized, "utf8") > ADVISOR_SESSION_KEY_MAX_BYTES
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError("normalized session_key exceeds its bound or contains control characters");
  }
  return normalized;
}

export function continuityIdForSessionKey(sessionKey: string): string {
  const digest = createHash("sha256")
    .update(normalizeAdvisorSessionKey(sessionKey), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `advisor:${digest}`;
}

export function advisorSuccess(input: {
  readonly continuityId: string;
  readonly model: string;
  readonly effort: AdvisorEffort;
  readonly review: string;
  readonly truncated?: boolean;
}): AdvisorReviewResponse {
  return {
    schema: ADVISOR_RESPONSE_SCHEMA,
    status: "succeeded",
    code: "ok",
    continuity_id: input.continuityId,
    model: input.model,
    effort: input.effort,
    review: input.review,
    ...(input.truncated === true ? { truncated: true } : {}),
  };
}

export function advisorFailure(input: {
  readonly status?: Exclude<AdvisorResultStatus, "succeeded">;
  readonly code: Exclude<AdvisorResultCode, "ok">;
  readonly message: string;
  readonly continuityId: string;
  readonly model: string;
  readonly effort: AdvisorEffort;
}): AdvisorReviewResponse {
  return {
    schema: ADVISOR_RESPONSE_SCHEMA,
    status: input.status ?? "failed",
    code: input.code,
    continuity_id: input.continuityId,
    model: input.model,
    effort: input.effort,
    error: { code: input.code, message: input.message },
  };
}

export function advisorToolResult(
  response: AdvisorReviewResponse,
  config: Pick<AdvisorConfig, "maxOutputChars" | "maxResponseBytes">,
): {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: Record<string, unknown>;
  readonly isError?: true;
} {
  const fitted = fitResponse(response, config);
  const text = fitted.review ?? `Advisor review failed (${fitted.code}): ${fitted.error?.message ?? "The review did not complete."}`;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: fitted as unknown as Record<string, unknown>,
    ...(fitted.code === "ok" ? {} : { isError: true as const }),
  };
}

function fitResponse(
  response: AdvisorReviewResponse,
  config: Pick<AdvisorConfig, "maxOutputChars" | "maxResponseBytes">,
): AdvisorReviewResponse {
  if (response.review === undefined) {
    return response;
  }
  const bounded = boundText(response.review, config.maxOutputChars);
  let candidate: AdvisorReviewResponse = {
    ...response,
    review: bounded.text,
    ...(bounded.truncated || response.truncated === true ? { truncated: true } : {}),
  };
  if (toolResultBytes(candidate) <= config.maxResponseBytes) {
    return candidate;
  }
  const codePoints = Array.from(bounded.text);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const next = { ...candidate, review: codePoints.slice(0, middle).join(""), truncated: true };
    if (toolResultBytes(next) <= config.maxResponseBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  candidate = { ...candidate, review: codePoints.slice(0, low).join(""), truncated: true };
  return candidate;
}

function toolResultBytes(response: AdvisorReviewResponse): number {
  const text = response.review ?? `Advisor review failed (${response.code}): ${response.error?.message ?? "The review did not complete."}`;
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text }],
    structuredContent: response,
    ...(response.code === "ok" ? {} : { isError: true }),
  }), "utf8");
}

function boundText(value: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  const sanitized = value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  if (sanitized.length <= maxChars) {
    return { text: sanitized, truncated: false };
  }
  return { text: Array.from(sanitized).slice(0, maxChars).join(""), truncated: true };
}

function configuredEfforts(): [AdvisorEffort, ...AdvisorEffort[]] {
  return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
}
