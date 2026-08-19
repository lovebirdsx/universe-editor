/*---------------------------------------------------------------------------------------------
 *  app.mjs — cold-launch e2e fixture for this extension.
 *
 *  Each spec imports `test`/`expect` from here. `test` cold-launches the editor
 *  with ONLY this extension loaded off disk (junction into an isolated
 *  user-extensions dir), mirroring VSCode's `--extensionDevelopmentPath`: no
 *  vsix pack, no install, no host relaunch race.
 *
 *  The editor binary comes from the harness's resolveEditorLaunchTarget (env
 *  driven: UNIVERSE_EDITOR_BIN, or the installed win32 build auto-detected).
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest, resolveEditorLaunchTarget, expect } from '@universe-editor/e2e-harness'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
if (!existsSync(join(projectRoot, 'package.json'))) {
  throw new Error(`app: no package.json in ${projectRoot}`)
}

const target = resolveEditorLaunchTarget()

// Isolated user-extensions dir holding a single junction → this extension. A
// junction (dir symlink) works on Windows + CI Linux alike; scanning follows
// it and reads the real dist/ in place.
const userExtensionsDir = mkdtempSync(join(tmpdir(), 'ues-__name__-'))
symlinkSync(projectRoot, join(userExtensionsDir, '__name__'), 'junction')

export const test = createColdAppTest({
  ...target,
  extensions: [],
  env: { UNIVERSE_USER_EXTENSIONS_DIR: userExtensionsDir },
})

export { expect }
