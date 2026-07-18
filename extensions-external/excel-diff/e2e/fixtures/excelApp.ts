/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the Excel viewer & diff extension e2e.
 *
 *  Same model as the PDF suite: the extension ships as a marketplace `.vsix` and
 *  lives outside the pnpm workspace, so it can't go through the built-in
 *  allowlist. We mirror VSCode's `--extensionDevelopmentPath` — point the host's
 *  user-extensions dir at an isolated temp dir that junctions in ONLY this
 *  extension's on-disk build, so it activates at launch without a vsix install.
 *
 *  Base extension set is `[]` (core only); the temp user dir supplies Excel.
 *--------------------------------------------------------------------------------------------*/

import {
  createColdAppTest,
  resolveEditorBuild,
} from '../../../../packages/e2e-harness/dist/index.js'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const extRoot = resolve(__dirname, '../..')
const { appRoot, mainEntry } = resolveEditorBuild()

const userExtensionsDir = mkdtempSync(join(tmpdir(), 'ue2-excel-ext-'))
symlinkSync(extRoot, join(userExtensionsDir, 'universe-excel-diff'), 'junction')

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: [],
  env: { UNIVERSE_USER_EXTENSIONS_DIR: userExtensionsDir },
})

export { expect, closeApp } from '../../../../packages/e2e-harness/dist/index.js'
