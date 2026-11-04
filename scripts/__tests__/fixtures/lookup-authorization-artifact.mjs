// Complete fictional real-schema artifacts, test-only; never approval or a production issuer.
import { createHash } from "node:crypto";
import { digest } from "../../lib/continuity-dataset.mjs";
import { LOOKUP_AUTHORIZATION_SCHEMA } from "../../lib/continuity-lookup-authorization.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
export function lookupAuthorizationArtifact(pilot, { registrationRawSha256, outputRoot, credentialPath, account = "fictional-account" }) {
  const { descriptor, registration: { codes, common } } = pilot, salt = "c".repeat(64);
  return { schema: LOOKUP_AUTHORIZATION_SCHEMA, authorizationId: "fictional-authorization", salt,
    accountCommitment: sha(`mono-agent/lookup-pilot/account-v1\0${salt}\0${account}`), timestamp: "2030-01-01T00:00:00Z",
    approver: "Fictional Approver", numericApprovalReference: "fictional-cap-approval-4USD",
    bindings: { registrationRawSha256, registrationSha256: digest(pilot), controllerCheckout: codes.R0, codes, protocol: common.protocol,
      catalog: common.catalog, policy: common.policy, source: common.lookupSource, selection: common.lookupSelection, reader: common.reader, descriptor, outputRoot, credentialPath } };
}
