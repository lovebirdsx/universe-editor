import * as readline from 'node:readline/promises'
import { homedir } from 'node:os'
import { UexError } from '../errors.js'
import { info, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { uexConfigPath, readUexConfig } from '../lib/configFile.js'
import { resolveRegistry, resolveToken } from '../lib/registry.js'
import { createGalleryClient } from '../lib/httpClient.js'
import { parseUnpublishTarget } from '../lib/unpublishTarget.js'

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export async function run(argv: string[]): Promise<number> {
  const { positionals, values } = parseCommandArgs('unpublish', argv, {
    registry: { type: 'string' },
    yes: { type: 'boolean' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex unpublish <publisher.name>[@<version>] [--yes] [--registry <url>]')
    info('')
    info('remove one version, or the whole extension when no version is given.')
    return 0
  }
  try {
    const raw = positionals[0]
    if (!raw) {
      throw new UexError('missing unpublish target', [
        'use <publisher>.<name>@<version> or <publisher>.<name>',
      ])
    }
    const target = parseUnpublishTarget(raw)

    const config = await readUexConfig(uexConfigPath(homedir()))
    const registry = resolveRegistry({
      flag: typeof values.registry === 'string' ? values.registry : undefined,
      env: process.env,
      config,
    })
    const token = resolveToken({ env: process.env, config, registry })

    if (target.version === null && values.yes !== true) {
      if (!process.stdin.isTTY) {
        throw new UexError(`removing ALL versions of ${target.id} needs confirmation`, [
          're-run with --yes in non-interactive environments',
        ])
      }
      if (!(await confirm(`remove ALL versions of ${target.id} from ${registry}? [y/N] `))) {
        info('aborted')
        return 1
      }
    }

    const client = createGalleryClient({ baseUrl: registry, token })
    await client.unpublish(target.id, target.version)
    info(
      target.version === null
        ? `removed ${target.id} (all versions) from ${registry}`
        : `removed ${target.id}@${target.version} from ${registry}`,
    )
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
