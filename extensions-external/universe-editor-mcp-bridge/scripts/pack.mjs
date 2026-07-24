/*
 * Package this extension into a `.vsix` (a plain zip whose body lives under
 * `extension/`), the format `extensionManagementService.installVSIX` consumes.
 * Run after `build` so `dist/extension.js` and `resources/bridge/bridge.mjs` exist.
 *
 * The payload (which files land in the VSIX) is derived from this extension's
 * `package.json` `files[]` by the shared `createVsix`, so it never drifts from
 * what the runtime ships. This extension is out-of-workspace, so we import the
 * packer from the repo-root package's `dist`.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const extRoot = resolve(root, '..')
const repoRoot = resolve(extRoot, '../..')
const { createVsix } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/extension-packaging/dist/index.js')).href
)

const manifest = JSON.parse(await readFile(resolve(extRoot, 'package.json'), 'utf8'))
const outName = `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`

await createVsix(extRoot, resolve(extRoot, outName))
console.log(`packaged → ${outName}`)
