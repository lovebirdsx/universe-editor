/**
 * Manifest validation moved to `@universe-editor/extensions-common/manifest-schema`
 * so the Node-side packaging + management services can share one validator. This
 * re-export keeps the host's existing `./manifest.js` import path working.
 */
export { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
