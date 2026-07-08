/*
 * Package this extension into a `.vsix` (a plain zip whose body lives under
 * `extension/`), the format `extensionManagementService.installVSIX` consumes.
 * Run after `build` so `dist/extension.js` exists. Resolves adm-zip from the repo
 * root (this extension is out-of-workspace and has no local node_modules).
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const extRoot = resolve(root, '..')
const repoRoot = resolve(extRoot, '../..')
const require = createRequire(
  resolve(repoRoot, 'packages/extension-packaging/package.json'),
)
const AdmZip = require('adm-zip')

const manifest = JSON.parse(await readFile(resolve(extRoot, 'package.json'), 'utf8'))
const outName = `${manifest.publisher}.${manifest.name}-${manifest.version}.vsix`
const outPath = resolve(extRoot, outName)

const zip = new AdmZip()
// Server-side OPC files the client ignores — present for VSIX shape parity.
zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
zip.addFile('extension.vsixmanifest', Buffer.from('<PackageManifest/>'))

// The client only reads `extension/**`; ship exactly what package.json lists.
zip.addLocalFile(resolve(extRoot, 'package.json'), 'extension')
zip.addLocalFile(resolve(extRoot, 'icon.png'), 'extension')
zip.addLocalFolder(resolve(extRoot, 'dist'), 'extension/dist')
zip.addLocalFolder(resolve(extRoot, 'assets'), 'extension/assets')

zip.writeZip(outPath)
console.log(`packaged → ${outName}`)
