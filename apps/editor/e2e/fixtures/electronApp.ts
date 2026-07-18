/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture shim.
 *
 *  The reusable launch/teardown logic now lives in `@universe-editor/e2e-harness`
 *  (parameterized by app paths). This shim binds it to the editor's packaged
 *  build and re-exports the historical surface (`test`, `expect`, `APP_ROOT`,
 *  `MAIN_ENTRY`, `closeApp`) so specs and the other fixtures keep importing from
 *  `../fixtures/electronApp.js` unchanged.
 *
 *  Extension baseline (P2): `extensions: []` — the core suite activates NO
 *  extensions, so cold starts don't spawn tsserver / markdown-LSP / other hosts.
 *  The few core specs that need a language/SCM provider to set up their scenario
 *  opt into it via a dedicated fixture (coreGitApp / coreTsApp / coreMarkdownApp).
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createColdAppTest } from '@universe-editor/e2e-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = resolve(__dirname, '..', '..')
export const MAIN_ENTRY = resolve(APP_ROOT, 'out', 'main', 'index.js')

export const test = createColdAppTest({ appRoot: APP_ROOT, mainEntry: MAIN_ENTRY, extensions: [] })

export { expect, closeApp } from '@universe-editor/e2e-harness'
export type { E2EFixtures } from '@universe-editor/e2e-harness'
