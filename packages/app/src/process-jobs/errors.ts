import { processJobPublicError, type ProcessJobErrorCode } from "@mono-agent/contracts";

export class ProcessJobServiceError extends Error {
  readonly code: ProcessJobErrorCode;
  readonly occupancy?: number;
  readonly limit?: number;
  readonly limitKey?: string;
  readonly conversationOccupancy?: number;
  readonly conversationLimit?: number;

  constructor(code: ProcessJobErrorCode, _message?: string, capacity?: { occupancy: number; limit: number; limitKey: string; conversationOccupancy?: number; conversationLimit?: number }) {
    super(processJobPublicError(code).message);
    this.name = "ProcessJobServiceError";
    this.code = code;
    if (capacity) {
      this.occupancy = capacity.occupancy;
      this.limit = capacity.limit;
      this.limitKey = capacity.limitKey;
      if (capacity.conversationOccupancy !== undefined) this.conversationOccupancy = capacity.conversationOccupancy;
      if (capacity.conversationLimit !== undefined) this.conversationLimit = capacity.conversationLimit;
    }
  }
}

