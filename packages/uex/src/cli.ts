#!/usr/bin/env node
/**
 * uex CLI entry. Subcommands are imported lazily so `uex package` does not pay
 * for fetch/editor-locator modules it never uses.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { UexError } from './errors.js'
import { printUexError, info } from './output.js'

const HELP = `uex — Universe Editor extension toolchain

usage: uex <command> [options]

commands:
  package     validate + bundle the extension into a .vsix
  ls          print the file list that would go into the .vsix
  dev         launch the editor with this directory as a dev extension
  login       store a marketplace publish token
  publish     package (if needed) and upload to the marketplace
  unpublish   remove a version or the whole extension
  whoami      show the token's publisher and approval status

run \`uex <command> --help\` for command-specific options.`

function printVersion(): void {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }
  info(pkg.version)
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'package':
      return (await import('./commands/package.js')).run(rest)
    case 'ls':
      return (await import('./commands/ls.js')).run(rest)
    case 'dev':
      return (await import('./commands/dev.js')).run(rest)
    case 'login':
      return (await import('./commands/login.js')).run(rest)
    case 'publish':
      return (await import('./commands/publish.js')).run(rest)
    case 'unpublish':
      return (await import('./commands/unpublish.js')).run(rest)
    case 'whoami':
      return (await import('./commands/whoami.js')).run(rest)
    case '--version':
    case '-v':
      printVersion()
      return 0
    case '--help':
    case '-h':
      info(HELP)
      return 0
    case undefined:
      info(HELP)
      return 1
    default:
      throw new UexError(`unknown command "${command}"`, ['run `uex --help` for the command list'])
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    printUexError(err)
    process.exitCode = err instanceof UexError ? err.exitCode : 1
  },
)
