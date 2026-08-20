/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Standalone CLI entry for the post-deploy install (`node install.js
 *  --bundle-hash <hash>`), run right after the bundle is extracted. Separate
 *  from bootstrap.js because that bundle statically imports native packages
 *  that do not exist until this install completes.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installBundle } from './install.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  let bundleHash: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bundle-hash') {
      bundleHash = argv[i + 1]
      i++
    }
  }
  if (bundleHash === undefined) {
    process.stderr.write('usage: node install.js --bundle-hash <hash>\n')
    process.exit(1)
  }
  try {
    await installBundle(path.dirname(fileURLToPath(import.meta.url)), bundleHash)
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main()
}
