import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseManifest } from '@universe-editor/extension-manifest/manifest-schema'
import { UexError } from '../errors.js'
import { info, out, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { listPackageFiles } from '../lib/packageFiles.js'
import type { PublishManifest } from '../lib/manifestChecks.js'

export async function run(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs('ls', argv, {
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex ls')
    info('')
    info('print the exact file list that would go into the VSIX.')
    return 0
  }
  try {
    const extensionDir = process.cwd()
    const manifestPath = path.join(extensionDir, 'package.json')
    if (!existsSync(manifestPath)) {
      throw new UexError(`no package.json in ${extensionDir}`, [
        'run `uex ls` from your extension root (the folder containing package.json)',
      ])
    }
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    const manifest = parseManifest(raw) as PublishManifest
    const rawFiles = (raw as { files?: unknown }).files
    if (Array.isArray(rawFiles)) manifest.files = rawFiles as readonly string[]
    for (const file of await listPackageFiles(extensionDir, manifest)) {
      out(file)
    }
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
