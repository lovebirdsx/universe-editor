import { homedir } from 'node:os'
import { UexError } from '../errors.js'
import { info, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { uexConfigPath, readUexConfig } from '../lib/configFile.js'
import { resolveRegistry, resolveToken } from '../lib/registry.js'
import { createGalleryClient } from '../lib/httpClient.js'

export async function run(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs('whoami', argv, {
    registry: { type: 'string' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex whoami [--registry <url>]')
    info('')
    info('show which publisher the stored token belongs to, and its approval status.')
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

    const client = createGalleryClient({ baseUrl: registry, token })
    const who = await client.whoami()
    info(`publisher: ${who.publisher} @ ${registry}`)
    if (who.status === 'pending') {
      info('status: pending（待审批）——管理员批准后即可 publish')
    } else if (who.status) {
      info(`status: ${who.status}`)
    }
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
