// @ts-check
// A reference to host-owned upgrade authority, not an alternative canonical store.
const digest = (value: any) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: any) => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");

/** @typedef {{version:1, rootId:string, authorityId:string, ownerKey:string, historyBucket:string}} HostJournalAuthority */
/** @typedef {{hostAuthority:HostJournalAuthority, disposition:'C'|'D', assertOwned:()=>Promise<void>, onPhase?:(phase:string)=>Promise<void>}} HostJournalDeletion */
/** @param {any} value */
export function validateHostJournalAuthority(value: any): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "authorityId,historyBucket,ownerKey,rootId,version"
    || value.version !== 1 || !digest(value.rootId) || !digest(value.authorityId)
    || !id(value.ownerKey) || !id(value.historyBucket)) throw new TypeError("Invalid host journal upgrade authority");
}

/** Canonical order for byte-identical staging/publication. @param {any} value */
export function canonicalHostJournalAuthority(value: any): { version: any; rootId: any; authorityId: any; ownerKey: any; historyBucket: any; } {
  validateHostJournalAuthority(value);
  return { version: value.version, rootId: value.rootId,
    authorityId: value.authorityId, ownerKey: value.ownerKey, historyBucket: value.historyBucket };
}

/** Compare fixed fields; caller property order is irrelevant. @param {any} a @param {any} b */
export function sameHostJournalAuthority(a: any, b: any): boolean {
  validateHostJournalAuthority(a); validateHostJournalAuthority(b);
  return ["version", "rootId", "authorityId", "ownerKey", "historyBucket"].every((key: string) => a[key] === b[key]);
}

/** Host claim/root validation is borrowed, never inferred from native catalogues.
 * The caller must hold/drain the conversation claim through the awaited operation.
 * @param {any} options
 */
export function validateHeaderUpgradeOptions(options: any): void {
  validateHostJournalAuthority(options?.hostAuthority);
  if (typeof options?.assertOwned !== "function") throw new TypeError("Native header upgrade requires a held host ownership assertion");
}

export type HostJournalAuthority = {version:1, rootId:string, authorityId:string, ownerKey:string, historyBucket:string};
export type HostJournalDeletion = {hostAuthority:HostJournalAuthority, disposition:'C'|'D', assertOwned:()=>Promise<void>, onPhase?:(phase:string)=>Promise<void>};
