// Lookup policy values. Extraction must not change these wire contracts or constants.
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
export const LOOKUP_ASSUMPTIONS = freeze({
  version: "assumed-v1",
  literalInput: "utf8_bytes_gte_tokens",
  framing: { base: 4096, inputItem: 256, reasoningItem: 1024, tool: 1024, schemaProperty: 256, instructions: 4096 },
  outputIncludesReasoning: true, restoredReasoningLteSettledOutput: true,
  inputMax: 272000, outputMax: 128000, tierMultiplierMax: 2,
  rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  rmax: 3.92,
});
export const LOOKUP_GUARD_CONTRACT = freeze({
  version: "lookup-guard-v1", provider: "openai-codex", model: "gpt-6.1-sol",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", effort: "high",
  slotId: "", runId: "", piMaxRetries: 0, maxRetries: 0,
});
export const LOOKUP_OUTCOMES = freeze({
  refused_pre_send: { hold: "none", pilot: "capacity_continues_policy_stops" },
  own_abort_after_send: { hold: "retained", pilot: "continues_slot_terminal" },
  settled: { hold: "actual_cost", pilot: "continues" },
  lost: { hold: "retained", pilot: "continues_slot_terminal" },
  integrity_stop: { hold: "retained", pilot: "sticky_stop" },
});
export const LOOKUP_PRE_SEND_REFUSALS = Object.freeze(["not_admitted_input_envelope", "lookup_request_limit", "not_admitted_cap", "lookup_stopped", "lookup_slot_terminal"]);
export const LOOKUP_GUARD_POLICY_REFUSALS = Object.freeze([
  "lookup_body_type_forbidden", "lookup_route_mismatch", "lookup_contract_mismatch", "lookup_option_forbidden", "lookup_external_fetch_forbidden",
  "lookup_headers_forbidden", "lookup_env_forbidden", "lookup_payload_forbidden", "lookup_initial_reasoning_forbidden",
  "lookup_prompt_cache_key_forbidden", "lookup_retry_profile_forbidden", "lookup_auxiliary_callers_forbidden",
  "lookup_method_forbidden", "lookup_model_switch_forbidden", "lookup_preparation_forbidden", "lookup_preparation_invalid", "lookup_tools_forbidden",
  "lookup_concurrent_request", "lookup_permit_missing", "lookup_assumptions_mismatch", "lookup_single_shot_send_required",
  "lookup_faux_permit_forbidden", "lookup_settlement_invalid", "lookup_cache_assignment_invalid",
  "lookup_pilot_boundary_required", "lookup_native_identity_forbidden", "lookup_unguarded_dispatch", "lookup_payload_repeated", "lookup_pilot_capability_invalid",
]);
export const LOOKUP_PERMIT_CONTRACT = freeze({
  version: "lookup-permit-v1",
  admissionFields: ["requestId", "slotId", "round", "payloadDigest", "rmax"],
  methods: ["admit", "consume", "settle", "stop"],
  outcomes: Object.keys(LOOKUP_OUTCOMES),
});
export const LOOKUP_PILOT_STOPS = Object.freeze([...new Set([...LOOKUP_GUARD_POLICY_REFUSALS,
  "completed", "auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted",
  "unpriced_reservation", "invalid_unit_rate", "budget_admission", "lookup_run_deadline", "lookup_worker_timeout",
  "lookup_unreconciled_processes", "lookup_repeated_loss", "lookup_ipc_invalid", "lookup_ipc_disconnected",
  "lookup_pilot_slot_ineligible", "lookup_preparation_invalid", "lookup_preparation_timeout", "lookup_persist_failed", "lookup_receipt_invalid", "lookup_arrival_persist_failed", "lookup_arrival_receipt_invalid", "lookup_worker_lost", "lookup_recovery_only",
  "lookup_invalid_usage", "lookup_unknown_tier", "lookup_hold_exceeded", "lookup_input_envelope_violated",
  "lookup_output_envelope_violated", "lookup_reasoning_envelope_violated", "lookup_body_mismatch",
  "lookup_permit_invalid", "lookup_settlement_failed", "lookup_stop_failed", "lookup_payload_repeated",
  "lookup_headers_forbidden", "lookup_prompt_cache_key_forbidden", "lookup_send_mismatch", "lookup_duplicate_terminal",
])]);
export const LOOKUP_GUARD_STOPS = Object.freeze([...new Set([...LOOKUP_GUARD_POLICY_REFUSALS,
  "auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted", "lookup_settlement_failed",
  "lookup_invalid_usage", "lookup_unknown_tier", "lookup_hold_exceeded", "lookup_input_envelope_violated",
  "lookup_output_envelope_violated", "lookup_reasoning_envelope_violated", "lookup_body_mismatch", "lookup_permit_invalid",
  "lookup_arrival_persist_failed", "lookup_arrival_receipt_invalid", "lookup_payload_repeated", "lookup_headers_forbidden", "lookup_prompt_cache_key_forbidden", "lookup_send_mismatch", "lookup_duplicate_terminal",
])]);
export const LOOKUP_INTEGRITY_STOPS = Object.freeze(LOOKUP_GUARD_STOPS.filter(code => !["auth_failure", "lookup_auth_failure", "lookup_account_mismatch", "lookup_quota_exhausted"].includes(code)));
export const LOOKUP_SLOT_TERMINALS = Object.freeze(["completed", "wrong", "lost", "own_abort_after_send", "pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified", "integrity_stop", "refused_pre_send", "unadmitted", "skipped"]);
export const USD_UNITS = 20000000n;
export const LOOKUP_AUTHORIZATION_SCHEMA = "continuity-lookup-pilot-authorization-v1";
export const LOOKUP_CONSUMPTION_SCHEMA = "continuity-lookup-pilot-consumed-v1";
export const LOOKUP_REGISTRY_LAYOUT = Object.freeze([
  [".local", false], ["state", false], ["mono-agent", true], ["lookup-pilot", true], ["consumed-v1", true],
].map(row => Object.freeze(row)));
export const LOOKUP_FAUX_AUTHORIZATION = "continuity-lookup-faux-authorization-v1";
export const LOOKUP_REAL_CONTROLLER = "continuity-lookup-controller-v1";
export const LOOKUP_FAUX_CONTROLLER = "continuity-lookup-faux-controller-v1";
export const LOOKUP_PILOT_IPC = "lookup-pilot-ipc-v1";
export const LOOKUP_PREFLIGHT = "lookup-preflight-controller-v1";
export const LOOKUP_TREE_LIMITS = Object.freeze({ fileBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 });

export class LookupGuardError extends Error {
  constructor(code, outcome = "refused_pre_send", classification = code, cause) {
    super(code, cause === undefined ? undefined : { cause }); this.code = code; this.outcome = outcome; this.classification = classification;
  }
}
