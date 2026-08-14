export interface AdvisorAdmissionLease {
  release(): void;
}

export interface AdvisorAdmissionGate {
  tryAcquire(key?: string): AdvisorAdmissionLease | undefined;
}

export class AdvisorConcurrencyGate implements AdvisorAdmissionGate {
  readonly #limit: number;
  readonly #activeKeys = new Set<string>();
  #active = 0;
  #closed = false;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("Advisor concurrency limit must be a positive integer.");
    }
    this.#limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  tryAcquire(key?: string): AdvisorAdmissionLease | undefined {
    if (this.#closed || this.#active >= this.#limit || (key !== undefined && this.#activeKeys.has(key))) {
      return undefined;
    }
    this.#active += 1;
    if (key !== undefined) this.#activeKeys.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active -= 1;
        if (key !== undefined) this.#activeKeys.delete(key);
      },
    };
  }

  close(): void {
    this.#closed = true;
  }
}
