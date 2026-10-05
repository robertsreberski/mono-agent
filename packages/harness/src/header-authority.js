// @ts-check
// A reference to host-owned upgrade authority, not an alternative canonical store.
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");

/** @typedef {{version:1, canonicalVersion:4, rootId:string, authorityId:string, ownerKey:string, historyBucket:string}} HostJournalAuthority */
/** @typedef {{hostAuthority:HostJournalAuthority, disposition:'C'|'D', assertOwned:()=>Promise<void>}} HostJournalDeletion */
/** @param {any} value */
export function validateHostJournalAuthority(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "authorityId,canonicalVersion,historyBucket,ownerKey,rootId,version"
    || value.version !== 1 || value.canonicalVersion !== 4 || !digest(value.rootId) || !digest(value.authorityId)
    || !id(value.ownerKey) || !id(value.historyBucket)) throw new TypeError("Invalid host journal upgrade authority");
}

/** Canonical order for byte-identical staging/publication. @param {any} value */
export function canonicalHostJournalAuthority(value) {
  validateHostJournalAuthority(value);
  return { version: value.version, canonicalVersion: value.canonicalVersion, rootId: value.rootId,
    authorityId: value.authorityId, ownerKey: value.ownerKey, historyBucket: value.historyBucket };
}

/** Compare fixed fields; caller property order is irrelevant. @param {any} a @param {any} b */
export function sameHostJournalAuthority(a, b) {
  validateHostJournalAuthority(a); validateHostJournalAuthority(b);
  return ["version", "canonicalVersion", "rootId", "authorityId", "ownerKey", "historyBucket"].every((key) => a[key] === b[key]);
}

/** Host claim/root validation is borrowed, never inferred from native catalogues.
 * The caller must hold/drain the conversation claim through the awaited operation.
 * @param {any} options
 */
export function validateHeaderUpgradeOptions(options) {
  validateHostJournalAuthority(options?.hostAuthority);
  if (typeof options?.assertOwned !== "function") throw new TypeError("Native header upgrade requires a held host ownership assertion");
}
