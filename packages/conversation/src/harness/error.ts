export class ConversationHarnessError extends Error {
  readonly failureKind: string;
  readonly details?: unknown;

  constructor(failureKind: string, message: string, details?: unknown) {
    super(message);
    this.name = "ConversationHarnessError";
    this.failureKind = failureKind;
    this.details = details;
  }
}
