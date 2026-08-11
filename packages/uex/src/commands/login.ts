import * as readline from 'node:readline/promises'
import { homedir } from 'node:os'
import { UexError } from '../errors.js'
import { info, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { uexConfigPath, readUexConfig, writeUexConfig } from '../lib/configFile.js'
import { resolveRegistry, normalizeRegistry } from '../lib/registry.js'
import { createGalleryClient } from '../lib/httpClient.js'
import { registerPageUrl } from '../lib/galleryApi.js'

const PUBLISHER_ID = /^[a-z0-9][a-z0-9-]*$/

async function askSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

export async function run(argv: string[]): Promise<number> {
  const { positionals, values } = parseCommandArgs('login', argv, {
    registry: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex login <publisher> [--registry <url>] [--token <token>]')
    info('')
    info('verify a marketplace publish token and store it in ~/.uex/config.json.')
    info('no token yet? register a publisher at <registry>/gallery/register — shown once.')
    return 0
  }
  try {
    const publisher = positionals[0]
    if (!publisher || !PUBLISHER_ID.test(publisher)) {
      throw new UexError(`invalid publisher id "${publisher ?? ''}"`, [
        'lowercase letters, digits and dashes, e.g. `uex login acme`',
      ])
    }

    const configPath = uexConfigPath(homedir())
    const config = await readUexConfig(configPath)
    const registry = resolveRegistry({
      flag: typeof values.registry === 'string' ? values.registry : undefined,
      env: process.env,
      config,
    })

    let token = typeof values.token === 'string' ? values.token : process.env.UNIVERSE_MARKET_TOKEN
    if (!token) {
      if (!process.stdin.isTTY) {
        throw new UexError('no token supplied and stdin is not interactive', [
          'pass --token <token> or set UNIVERSE_MARKET_TOKEN',
          `no token yet? register a publisher at ${registerPageUrl(registry)}`,
        ])
      }
      token = await askSecret(`publish token for ${publisher} @ ${registry}: `)
    }

    const client = createGalleryClient({ baseUrl: registry, token })
    const who = await client.whoami()
    if (who.publisher !== publisher) {
      throw new UexError(`token belongs to "${who.publisher}", not "${publisher}"`, [
        `run \`uex login ${who.publisher}\` with this token, or get a token for "${publisher}"`,
      ])
    }

    config.defaultRegistry ??= registry
    config.registries = {
      ...config.registries,
      [normalizeRegistry(registry)]: { token, publisher },
    }
    await writeUexConfig(configPath, config)
    info(`logged in as ${publisher} @ ${registry}`)
    if (who.status === 'pending') {
      info('note: this publisher is pending approval — publishing unlocks once an admin approves')
    }
    info(
      `token stored in plain text at ${configPath} (same as ~/.vsce) — prefer UNIVERSE_MARKET_TOKEN on shared machines`,
    )
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
