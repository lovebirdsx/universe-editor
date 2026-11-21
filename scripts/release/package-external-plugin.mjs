#!/usr/bin/env node
/**
 * Package an out-of-repo extension folder into a VSIX.
 *
 * External plugins use the exact same manifest validation and file whitelist
 * as the in-repo packaging toolchain, so this is a thin CLI over createVsix.
 * Build the plugin first.
 *
 * usage:
 *   node scripts/release/package-external-plugin.mjs --extension-dir <dir> [--out <vsix>]
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createVsix,
  extensionPackageFiles,
  isPathCoveredByPackageFiles,
} from '@universe-editor/extension-packaging'

/**
 * Entry points must exist on disk AND ship: the renderer/main loader reads them
 * from the installed payload, so a missing `files` entry only breaks on the
 * user's machine. Returns human-readable errors; empty means valid.
 */
export function validateExtensionPayload(extensionDir, manifest) {
  const shipped = extensionPackageFiles({
    ...(typeof manifest.main === 'string' ? { main: manifest.main } : {}),
    ...(Array.isArray(manifest.files) ? { files: manifest.files } : {}),
    contributes: manifest.contributes,
  })
  const entryChecks = [['main', manifest.main]]
  const trustedViews = Array.isArray(manifest.contributes?.trustedViews)
    ? manifest.contributes.trustedViews
    : []
  for (const view of trustedViews) {
    entryChecks.push([`contributes.trustedViews "${view?.id ?? '?'}".entry`, view?.entry])
  }

  const errors = []
  for (const [label, entry] of entryChecks) {
    if (typeof entry !== 'string') continue
    const relative = entry.replaceAll('\\', '/')
    if (!existsSync(path.join(extensionDir, relative))) {
      errors.push(`${label} "${entry}" does not exist — run the plugin build first`)
    } else if (!isPathCoveredByPackageFiles(shipped, relative)) {
      errors.push(
        `${label} "${entry}" is not covered by the package files whitelist — add its directory to "files" in package.json`,
      )
    }
  }
  return errors
}

async function main() {
  const { values } = parseArgs({
    options: {
      'extension-dir': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  })

  if (values.help || values['extension-dir'] === undefined) {
    console.log(
      'usage: node scripts/release/package-external-plugin.mjs --extension-dir <dir> [--out <vsix>]',
    )
    process.exit(values.help ? 0 : 1)
  }

  const extensionDir = path.resolve(values['extension-dir'])
  const manifestPath = path.join(extensionDir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.error(`error: no package.json in ${extensionDir}`)
    process.exit(1)
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const errors = validateExtensionPayload(extensionDir, manifest)
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`)
    process.exit(1)
  }

  const publisher = manifest.publisher ?? ''
  const name = manifest.name
  const version = manifest.version
  const outPath = values.out
    ? path.resolve(values.out)
    : path.join(extensionDir, `${publisher === '' ? '' : `${publisher}.`}${name}-${version}.vsix`)

  await createVsix(extensionDir, outPath)
  console.log(`created ${outPath}`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) await main()
