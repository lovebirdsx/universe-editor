/**
 * ESLint extension (client). On activation it resolves the bundled standalone
 * server (dist/server.js beside this file), spawns it via EslintClient, wires a
 * diagnostics collection, document sync, code actions, the fix-all command, and
 * — gated by settings — the formatter and save-time fix-all. The heavy ESLint
 * work runs in the server subprocess; this file is pure wiring.
 */
import {
  commands,
  languages,
  window,
  workspace,
  StatusBarAlignment,
  type CodeAction,
  type CodeActionContext,
  type ExtensionContext,
  type OutputChannel,
  type Range,
  type StatusBarItem,
  type TextDocument,
  type TextEdit,
  type UriComponents,
} from '@universe-editor/extension-api'
import { URI } from 'vscode-uri'
import { EslintClient, type PublishDiagnosticsEvent } from './eslintClient.js'
import { type EslintLogLevel, type EslintSettings, type EslintStatus } from './protocol.js'

/** Languages we register providers for (superset of the default validate list;
 *  the server still gates on the effective `eslint.validate` setting). */
const ESLINT_LANGUAGES = [
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
  'vue',
  'svelte',
  'astro',
]

function uriString(uri: UriComponents): string {
  return URI.from({
    scheme: uri.scheme,
    authority: uri.authority ?? '',
    path: uri.path ?? '',
    query: uri.query ?? '',
    fragment: uri.fragment ?? '',
  }).toString()
}

function uriComponents(uri: string): UriComponents {
  const u = URI.parse(uri)
  return {
    scheme: u.scheme,
    authority: u.authority,
    path: u.path,
    query: u.query,
    fragment: u.fragment,
  }
}

async function loadSettings(): Promise<EslintSettings> {
  const cfg = workspace.getConfiguration('eslint')
  const [validate, run, options] = await Promise.all([
    cfg.get<string[]>('validate', [
      'javascript',
      'javascriptreact',
      'typescript',
      'typescriptreact',
    ]),
    cfg.get<'onType' | 'onSave'>('run', 'onType'),
    cfg.get<Record<string, unknown>>('options', {}),
  ])
  return { validate, run, options }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const enabled = await workspace.getConfiguration('eslint').get<boolean>('enable', true)
  if (!enabled) {
    console.error('[eslint] disabled via eslint.enable; not activating')
    return
  }

  const output = window.createOutputChannel('ESLint')
  const log = makeLogger(output)
  const status = window.createStatusBarItem(StatusBarAlignment.Right, 0)
  status.command = 'eslint.showOutputChannel'
  applyStatus(status, 'ok')

  const serverModule = `${context.extensionPath}/dist/server.js`
  const rootUri = workspace.rootPath ? URI.file(workspace.rootPath).toString() : null

  const settings = await loadSettings()
  const diagnostics = languages.createDiagnosticCollection('eslint')
  const client = new EslintClient(serverModule, rootUri, settings, {
    onDiagnostics: (e: PublishDiagnosticsEvent) => {
      diagnostics.set(uriComponents(e.uri), e.diagnostics)
    },
    log,
    onStatus: (s: EslintStatus, message?: string) => applyStatus(status, s, message),
  })

  context.subscriptions.push(output, status, diagnostics, { dispose: () => client.dispose() })
  log('info', `activating ESLint extension (root=${rootUri ?? '(none)'})`)
  log('info', `server module: ${serverModule}`)
  log('info', `settings: run=${settings.run}, validate=[${settings.validate.join(', ')}]`)

  registerDocumentSync(context, client)
  registerCodeActions(context, client)
  registerCommands(context, client, output)
  await registerFormattingAndSave(context, client, log)
}

/** Two-digit-padded `HH:MM:SS` prefix so channel lines read like a real log. */
function makeLogger(output: OutputChannel): (level: EslintLogLevel, message: string) => void {
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`)
  return (level, message) => {
    const d = new Date()
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    output.appendLine(`[${ts}] [${level}] ${message}`)
  }
}

/** Map a coarse status to the status-bar item's text/tooltip (a click opens the
 *  output channel). Uses `$(icon)` glyph syntax the workbench renders. */
function applyStatus(item: StatusBarItem, status: EslintStatus, message?: string): void {
  const glyph = status === 'ok' ? '$(check)' : status === 'warn' ? '$(warning)' : '$(error)'
  item.text = `${glyph} ESLint`
  item.tooltip = message ?? 'ESLint — click to open the output channel'
  item.show()
}

function registerDocumentSync(context: ExtensionContext, client: EslintClient): void {
  const relevant = (doc: TextDocument): boolean => ESLINT_LANGUAGES.includes(doc.languageId)
  const open = (doc: TextDocument): void => {
    if (relevant(doc)) {
      void client.didOpen(uriString(doc.uri), doc.languageId, doc.version, doc.getText())
    }
  }
  for (const doc of workspace.textDocuments) open(doc)

  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => open(doc)),
    workspace.onDidChangeTextDocument((e) => {
      if (relevant(e.document)) {
        void client.didChange(uriString(e.document.uri), e.document.version, e.document.getText())
      }
    }),
    workspace.onDidCloseTextDocument((doc) => {
      if (relevant(doc)) void client.didClose(uriString(doc.uri))
    }),
  )
}

function registerCodeActions(context: ExtensionContext, client: EslintClient): void {
  context.subscriptions.push(
    languages.registerCodeActionsProvider(ESLINT_LANGUAGES, {
      provideCodeActions: async (
        doc: TextDocument,
        range: Range,
        _ctx: CodeActionContext,
      ): Promise<CodeAction[]> => {
        const actions = await client.codeAction(uriString(doc.uri), {
          start: { line: range.start.line, character: range.start.character },
          end: { line: range.end.line, character: range.end.character },
        })
        return actions.map((a): CodeAction => {
          const action: CodeAction = {
            title: a.title,
            kind: a.kind,
            edit: { changes: { [uriString(doc.uri)]: [...a.edits] } },
          }
          if (a.isPreferred) action.isPreferred = true
          return action
        })
      },
    }),
  )
}

function registerCommands(
  context: ExtensionContext,
  client: EslintClient,
  output: OutputChannel,
): void {
  context.subscriptions.push(
    commands.registerCommand('eslint.executeAutofix', async () => {
      const editor = await window.getActiveTextEditor()
      if (!editor) return
      const uri = uriString(editor.document.uri)
      const { edits } = await client.fixAllEdits(uri)
      if (edits.length > 0) await editor.edit((builder) => applyEdits(builder, edits))
    }),
    commands.registerCommand('eslint.restart', async () => {
      output.appendLine('Restarting ESLint server…')
      await client.restart()
    }),
    commands.registerCommand('eslint.showOutputChannel', () => output.show()),
  )
}

async function registerFormattingAndSave(
  context: ExtensionContext,
  client: EslintClient,
  log: (level: EslintLogLevel, message: string) => void,
): Promise<void> {
  const cfg = workspace.getConfiguration('eslint')
  const [formatEnable, codeActionsOnSave] = await Promise.all([
    cfg.get<boolean>('format.enable', false),
    cfg.get<boolean>('codeActionsOnSave.enable', false),
  ])

  log('info', `format.enable=${formatEnable}, codeActionsOnSave.enable=${codeActionsOnSave}`)

  if (formatEnable) {
    context.subscriptions.push(
      languages.registerDocumentFormattingEditProvider(ESLINT_LANGUAGES, {
        provideDocumentFormattingEdits: async (doc: TextDocument): Promise<TextEdit[]> => {
          const { edits } = await client.fixAllEdits(uriString(doc.uri))
          return [...edits]
        },
      }),
    )
  }

  if (codeActionsOnSave) {
    context.subscriptions.push(
      workspace.onWillSaveTextDocument((e) => {
        if (!ESLINT_LANGUAGES.includes(e.document.languageId)) return
        void e.reason // reason available; we fix-all on every save reason
        e.waitUntil(client.fixAllEdits(uriString(e.document.uri)).then((r) => [...r.edits]))
      }),
    )
  }
}

/** Apply LSP TextEdits through a TextEditorEdit builder (LSP ranges are already
 *  0-based, matching the builder's coordinate space). */
function applyEdits(
  builder: { replace(range: Range, text: string): void },
  edits: readonly TextEdit[],
): void {
  for (const e of edits) builder.replace(e.range, e.newText)
}

export function deactivate(): void {
  // Subscriptions (including client disposal) are cleaned up by the host.
}
