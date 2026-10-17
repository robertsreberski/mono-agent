export function isDoctorObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function continuationFsCode(error: unknown): string | undefined {
  return isDoctorObject(error) && typeof error.code === "string" ? error.code : undefined;
}

export function continuationReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
