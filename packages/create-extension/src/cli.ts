#!/usr/bin/env node
/**
 * `npm create @universe-editor/extension [directory]` entry. Fully flag-driven
 * invocation skips the interactive prompts (CI / AI agents); anything missing
 * is asked interactively via @clack/prompts.
 */
import { parseArgs } from 'node:util'
import * as path from 'node:path'
import { scaffold } from './scaffold.js'
import { promptForMissing, isNonInteractive, type PartialAnswers } from './prompt.js'
import { validateExtensionName, validatePublisher } from './validate.js'
import { ScaffoldError } from './errors.js'
import { SDK_VERSIONS } from './sdkVersions.js'
import type { ScaffoldAnswers } from './placeholders.js'

const HELP = `create-extension — scaffold a Universe Editor extension

usage: npm create @universe-editor/extension [directory] -- [options]

options:
  --name <id>           extension id (lowercase npm-name rules)
  --publisher <id>      publisher id (must match your publish token)
  --display-name <text> human-readable name (defaults to --name)
  --description <text>  one-line description
  --template <t>        basic | webview
  --force               write into a non-empty directory (never deletes)
  --help                show this help`

function printScaffoldError(err: unknown): void {
  if (err instanceof ScaffoldError) {
    console.error(`error: ${err.message}`)
    for (const hint of err.hints) {
      console.error(`→ ${hint}`)
    }
    return
  }
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      name: { type: 'string' },
      publisher: { type: 'string' },
      'display-name': { type: 'string' },
      description: { type: 'string' },
      template: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(HELP)
    return 0
  }

  const template: 'basic' | 'webview' | undefined =
    values.template === 'basic' || values.template === 'webview' ? values.template : undefined
  const partial: PartialAnswers = {
    name: values.name,
    publisher: values.publisher,
    displayName: values['display-name'],
    description: values.description,
    template,
  }

  let answers: ScaffoldAnswers
  if (isNonInteractive(partial)) {
    const nameError = validateExtensionName(partial.name)
    if (nameError) throw new ScaffoldError(`invalid extension name: ${nameError}`)
    const publisherError = validatePublisher(partial.publisher)
    if (publisherError) throw new ScaffoldError(`invalid publisher: ${publisherError}`)
    answers = {
      name: partial.name,
      publisher: partial.publisher,
      displayName: partial.displayName ?? partial.name,
      description: partial.description ?? '',
      template: partial.template,
    }
  } else {
    answers = await promptForMissing(partial)
  }

  const targetDir = path.resolve(positionals[0] ?? answers.name)
  await scaffold(answers, {
    targetDir,
    force: values.force ?? false,
    versions: SDK_VERSIONS,
  })

  const rel = path.relative(process.cwd(), targetDir) || '.'
  console.log(`\ncreated ${answers.name} in ${rel}\n`)
  console.log('next steps:')
  console.log(`  cd ${rel}`)
  console.log('  npm install')
  console.log('  npm run watch            # bundle src → dist, rebuild on change')
  console.log('  npx uex dev --inspect=9229   # launch the Extension Development Host')
  console.log('  # then F5 in VSCode attaches the debugger\n')
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    printScaffoldError(err)
    process.exitCode = 1
  },
)
