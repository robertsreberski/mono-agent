

export class ToolHistoryWriterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolHistoryWriterError";
    this.code = code;
  }
}
