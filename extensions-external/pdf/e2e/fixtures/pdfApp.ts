/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the PDF extension e2e.
 *
 *  The PDF extension ships as a marketplace `.vsix` and lives OUTSIDE the pnpm
 *  workspace, so it cannot be activated via the built-in allowlist
 *  (UNIVERSE_ENABLED_EXTENSIONS gates only bundled built-ins). Instead we mirror
 *  VSCode's `--extensionDevelopmentPath`: point the host's user-extensions dir at
 *  an isolated temp dir that junctions in ONLY this extension's on-disk build
 *  (dist/ + package.json), so it is scanned + activated at launch — no vsix pack,
 *  no install, no host relaunch race.
 *
 *  The base extension set is `[]` (core only): the temp user dir supplies PDF,
 *  and nothing else built-in boots (no tsserver / markdown LSP warmup).
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

// Isolated user-extensions dir holding a single junction → this extension. A
// junction (dir symlink) works on Windows + CI Linux alike; the type arg is
// ignored off Windows. Scanning follows it and reads the real dist/ in place.
const userExtensionsDir = mkdtempSync(join(tmpdir(), 'ue2-pdf-ext-'))
symlinkSync(extRoot, join(userExtensionsDir, 'universe-pdf'), 'junction')

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: [],
  env: { UNIVERSE_USER_EXTENSIONS_DIR: userExtensionsDir },
})

export { expect, closeApp } from '../../../../packages/e2e-harness/dist/index.js'
