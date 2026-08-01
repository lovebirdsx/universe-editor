import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { UexError } from '../errors.js'
import { info, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { locateEditor, defaultEditorLocatorDeps } from '../lib/editorLocator.js'
import { buildEditorArgs, launchEditor } from '../lib/editorLaunch.js'

function parsePort(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UexError(`--inspect expects a port number, got "${String(raw)}"`, [
      'example: uex dev --inspect=9229',
    ])
  }
  return port
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs('dev', argv, {
    inspect: { type: 'string' },
    'user-data-dir': { type: 'string' },
    'editor-path': { type: 'string' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex dev [--inspect=<port>] [--user-data-dir=<dir>] [--editor-path=<exe>]')
    info('')
    info('launch an installed Universe Editor with the current directory loaded as an')
    info('extension under development (debuggable via --inspect + VSCode attach).')
    return 0
  }
  try {
    const extensionDir = process.cwd()
    if (!existsSync(path.join(extensionDir, 'package.json'))) {
      throw new UexError(`no package.json in ${extensionDir}`, [
        'run `uex dev` from your extension root (the folder containing package.json)',
      ])
    }

    const flagPath = typeof values['editor-path'] === 'string' ? values['editor-path'] : undefined
    const editor = locateEditor({ flagPath }, defaultEditorLocatorDeps(process.platform))
    if (!editor) {
      throw new UexError('could not find an installed Universe Editor', [
        'install Universe Editor first, or',
        'set UNIVERSE_EDITOR_PATH to the editor executable, or',
        'pass --editor-path <path-to-exe>',
      ])
    }

    const args = buildEditorArgs({
      extensionPath: extensionDir,
      inspectPort: parsePort(values.inspect),
      userDataDir:
        typeof values['user-data-dir'] === 'string' ? values['user-data-dir'] : undefined,
    })
    launchEditor(editor.exePath, args)
    info(`launched ${editor.exePath} (${editor.source})`)
    for (const arg of args) info(`  ${arg}`)
    if (values.inspect !== undefined) {
      info('attach your debugger to 127.0.0.1:' + String(values.inspect))
    }
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
