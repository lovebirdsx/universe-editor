/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for the ESLint extension e2e.
 *
 *  Like the PDF / Excel suites, the ESLint extension ships as a marketplace
 *  `.vsix` outside the pnpm workspace, so it's loaded off disk via
 *  UNIVERSE_USER_EXTENSIONS_DIR (VSCode's `--extensionDevelopmentPath` model),
 *  not the built-in allowlist.
 *
 *  ESLint additionally needs a real linting target: the extension spawns a
 *  standalone server that resolves `eslint` from the LINTED FILE's directory
 *  (createRequire), so the fixture builds a temp workspace holding:
 *    - a flat `eslint.config.js` with one rule that will fire (no-unused-vars),
 *    - `node_modules/eslint` junctioned to the repo's own eslint 9 (resolvable),
 *    - a `.js` file with a deterministic violation.
 *  The spec opens the workspace, trusts it (the extension declares `main` +
 *  `untrustedWorkspaces.supported=false`, so it's gated off until trusted), and
 *  asserts diagnostics appear.
 *--------------------------------------------------------------------------------------------*/

import {
  createColdAppTest,
  resolveEditorBuild,
} from '../../../../packages/e2e-harness/dist/index.js'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const extRoot = resolve(__dirname, '../..')
const repoRoot = resolve(__dirname, '../../../..')
const { appRoot, mainEntry } = resolveEditorBuild()

// Load the extension off disk via an isolated, junctioned user-extensions dir.
const userExtensionsDir = mkdtempSync(join(tmpdir(), 'ue2-eslint-ext-'))
symlinkSync(extRoot, join(userExtensionsDir, 'universe-eslint'), 'junction')

// The eslint package the server must resolve from the workspace (repo's eslint 9).
// Borrow it via the typescript extension that depends on it — same borrow the
// extension's own tooling uses.
const require = createRequire(resolve(repoRoot, 'extensions/typescript/package.json'))
const eslintPkgDir = dirname(require.resolve('eslint/package.json'))

/**
 * Build a fresh temp workspace with a flat config, a junctioned eslint, and a
 * file carrying a deterministic `no-unused-vars` violation. Returns the folder
 * and the violating file's path. Each test calls this so runs don't share state.
 */
export function makeEslintWorkspace(): { readonly dir: string; readonly filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ue2-eslint-ws-'))
  // Flat config as .mjs so Node always loads it as ESM (a plain .js would need a
  // package.json `"type":"module"` and otherwise fails with "Unexpected token
  // 'export'"). Enable the one rule the fixture file will trip.
  writeFileSync(
    join(dir, 'eslint.config.mjs'),
    `export default [{ rules: { 'no-unused-vars': 'error' } }]\n`,
    'utf8',
  )
  // Resolvable eslint: the server does createRequire(<fileDir>).resolve('eslint').
  const nm = join(dir, 'node_modules')
  mkdirSync(nm, { recursive: true })
  symlinkSync(eslintPkgDir, join(nm, 'eslint'), 'junction')
  // A file that ESLint will flag: `unused` is declared but never read. Plain
  // script syntax (no import/export) so the default parser accepts it without a
  // sourceType override in the flat config.
  const filePath = join(dir, 'index.js')
  writeFileSync(filePath, `const unused = 42\nconsole.log('ok')\n`, 'utf8')
  return { dir, filePath }
}

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: [],
  env: { UNIVERSE_USER_EXTENSIONS_DIR: userExtensionsDir },
})

export { expect, closeApp } from '../../../../packages/e2e-harness/dist/index.js'
