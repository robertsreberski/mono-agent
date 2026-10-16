/**
 * Shared base for the workspace's typed errors. The repo had ~30 error classes
 * in five mutually incompatible shapes; this base captures the reference shape
 * (a `code` discriminant plus a `details` object that always echoes the code and
 * preserves `this.name`) so packages can converge incrementally without changing
 * their runtime field layout.
 */
export class CodedError<Code extends string = string> extends Error {
  readonly code: Code;
  readonly details: Record<string, unknown>;

  constructor(
    code: Code,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    // The most-derived subclass name, so subclasses keep their own `name`
    // without re-assigning it.
    this.name = new.target.name;
    this.code = code;
    this.details = { ...details, code };
  }
}
