
export interface RunWebCommandOptions {
  readonly positionals: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly host?: string;
  readonly port?: number;
  readonly theme?: string;
  readonly name?: string;
  readonly loopback?: boolean;
  readonly shareTailnet?: boolean;
  readonly json?: boolean;
  readonly follow?: boolean;
  readonly lines?: number;
  readonly all?: boolean;
  readonly yes?: boolean;
}
