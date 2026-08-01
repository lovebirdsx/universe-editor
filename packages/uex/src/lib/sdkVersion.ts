/**
 * The extension API version uex itself was built against — used by the
 * engines.universe coverage warning (authors most often target the current
 * API). Guarded by a test that reads packages/extension-api/package.json so
 * an API bump without a matching bump here fails loudly.
 */
export const CURRENT_API_VERSION = '0.7.1'
