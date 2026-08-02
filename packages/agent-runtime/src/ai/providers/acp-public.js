// Public high-level ACP surface. The owned stdio connection and raw protocol
// session state stay in acp-client.js and are intentionally not package exports.

/** @typedef {import("./acp-client.js").AcpProfileDescriptor} AcpProfileDescriptor */
/** @typedef {import("./acp-client.js").AcpCallbackContext} AcpCallbackContext */
/** @typedef {import("./acp-client.js").AcpInteractionRequest} AcpInteractionRequest */
/** @typedef {import("./acp-client.js").AcpClientHostOptions} AcpClientHostOptions */
/** @typedef {import("./acp-client.js").AcpListedSession} AcpListedSession */
/** @typedef {import("./acp-client.js").AcpSessionListResult} AcpSessionListResult */

export {
  ACP_PROTOCOL_VERSION,
  AcpClientError,
  authenticateAcpProfile,
  deleteAcpSession,
  listAcpSessions,
  logoutAcpProfile,
  probeAcpProfile,
  validateAcpProfileId,
  validateAcpProviderSessionId,
} from "./acp-client.js";
