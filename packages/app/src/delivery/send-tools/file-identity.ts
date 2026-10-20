export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export function fileIdentity(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

export function sameFileIdentity(
  stats: { readonly dev: number; readonly ino: number },
  expected: FileIdentity,
): boolean {
  return stats.dev === expected.dev && stats.ino === expected.ino;
}

export function parseFileIdentity(devValue: string | undefined, inoValue: string | undefined): FileIdentity | undefined {
  const dev = Number(devValue);
  const ino = Number(inoValue);
  return Number.isSafeInteger(dev) && dev >= 0 && Number.isSafeInteger(ino) && ino > 0
    ? { dev, ino }
    : undefined;
}
