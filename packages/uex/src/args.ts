import { parseArgs } from 'node:util'
import { UexError } from './errors.js'

export interface ParsedArgs {
  readonly positionals: string[]
  readonly values: Record<string, string | boolean | undefined>
}

interface ArgSpec {
  readonly [name: string]: { readonly type: 'string' | 'boolean' }
}

/**
 * Strict per-command parseArgs wrapper: unknown flags are rejected with a
 * hint instead of being silently ignored (parseArgs strict mode does this;
 * we just translate the error into UexError shape).
 */
export function parseCommandArgs(
  command: string,
  argv: readonly string[],
  spec: ArgSpec,
): ParsedArgs {
  try {
    const { positionals, values } = parseArgs({
      args: argv as string[],
      options: spec,
      strict: true,
      allowPositionals: true,
    })
    return { positionals, values: values as Record<string, string | boolean | undefined> }
  } catch (err) {
    throw new UexError((err as Error).message, [`run \`uex ${command} --help\` for usage`])
  }
}
