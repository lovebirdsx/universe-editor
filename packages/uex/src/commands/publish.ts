import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { readVsixManifest } from '@universe-editor/extension-packaging'
import { UexError } from '../errors.js'
import { info, warn, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { runPackage } from './package.js'
import { uexConfigPath, readUexConfig } from '../lib/configFile.js'
import { resolveRegistry, resolveToken } from '../lib/registry.js'
import { createGalleryClient } from '../lib/httpClient.js'

/** pdf-class extensions carry ~19MB of viewer assets; warn, don't block. */
const LARGE_VSIX_BYTES = 20 * 1024 * 1024

export async function run(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs('publish', argv, {
    'package-path': { type: 'string' },
    registry: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex publish [--package-path <vsix>] [--registry <url>] [--force]')
    info('')
    info('package the extension (unless --package-path is given) and upload the VSIX')
    info('to the marketplace. Credentials come from `uex login` or UNIVERSE_MARKET_TOKEN.')
    info('--force downgrades the engines.universe coverage error to a warning.')
    return 0
  }
  try {
    const config = await readUexConfig(uexConfigPath(homedir()))
    const registry = resolveRegistry({
      flag: typeof values.registry === 'string' ? values.registry : undefined,
      env: process.env,
      config,
    })
    const token = resolveToken({ env: process.env, config, registry })

    let vsixPath: string
    if (typeof values['package-path'] === 'string') {
      vsixPath = path.resolve(values['package-path'])
    } else {
      info('packaging first (no --package-path given)…')
      vsixPath = (await runPackage({ cwd: process.cwd(), force: values.force === true })).vsixPath
    }

    const manifest = readVsixManifest(vsixPath)
    if (!manifest.publisher) {
      throw new UexError(`the VSIX manifest has no publisher`, [
        're-package with "publisher" set in package.json',
      ])
    }

    const size = (await stat(vsixPath)).size
    if (size > LARGE_VSIX_BYTES) {
      warn(
        `the VSIX is ${(size / 1024 / 1024).toFixed(1)} MB — the server may reject very large uploads (413)`,
      )
    }

    const client = createGalleryClient({ baseUrl: registry, token })
    const result = await client.publish(await readFile(vsixPath))
    info(`published ${result.id}@${result.version} to ${registry}`)
    info('users can now find it in the editor’s Extensions view')
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
