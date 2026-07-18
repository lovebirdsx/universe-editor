/*---------------------------------------------------------------------------------------------
 *  Page Object shim. The POs now live in `@universe-editor/e2e-harness`; this
 *  re-exports the historical surface so specs keep importing from
 *  `../pages/WorkbenchPO.js` unchanged.
 *--------------------------------------------------------------------------------------------*/

export { WorkbenchPO, expectNoLeaks, evaluateWhenRestored } from '@universe-editor/e2e-harness'
