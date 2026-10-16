// Shared turn contracts, authored as JSDoc; no runtime implementation imports.



/**
 * @typedef {"pi"} RuntimeSdkId
 * Runtime-result and telemetry label. Model references no longer carry this
 * field because Pi is the sole runtime bridge.
 */

/**
 * @typedef {"pi"} RuntimeBridgeId
 * Direct Pi bridge id returned by src/runtime/bridges.js.
 */

/**
 * @typedef {Object} RuntimeModelRef
 * @property {string} provider            Pi provider id.
 * @property {string} model               Provider model id.
 * @property {string} reference           Canonical `<provider>:<model>` reference.
 */
