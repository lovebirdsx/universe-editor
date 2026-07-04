/**
 * TypeScript language features as a built-in plugin. On activation it spawns an
 * in-process `typescript-language-server` (LspClient) and wires the full set of
 * language providers, a diagnostics collection, and document sync to it — the
 * VSCode-native shape, where TS is just another extension.
 *
 * CLI + tsserver paths come from the main process via env (UNIVERSE_TSLS_CLI /
 * UNIVERSE_TSLS_TSSERVER); the plugin itself touches no Electron API.
 */
import {
  languages,
  workspace,
  FileType,
  type CompletionContext,
  type ExtensionContext,
  type SignatureHelpContext,
  type TextDocument,
  type UriComponents,
} from '@universe-editor/extension-api'
import { URI } from 'vscode-uri'
import { LspClient } from './lspClient.js'

const TS_JS_LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']

/** File extension → LSP languageId for the seed document that pins the project. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.jsx': 'javascriptreact',
}

/** Directories never worth descending into when hunting for a seed file. */
const PREWARM_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next'])
/** Bound the seed-file search so a huge tree can't stall prewarm. */
const PREWARM_MAX_DIRS = 200

/** tsserver completion trigger characters (mirrors the core TS provider). */
const COMPLETION_TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<', '#', ' ']
const SIGNATURE_TRIGGER_CHARACTERS = ['(', ',', '<']
const SIGNATURE_RETRIGGER_CHARACTERS = [')']

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

export function activate(context: ExtensionContext): void {
  const cli = process.env.UNIVERSE_TSLS_CLI
  const tsserver = process.env.UNIVERSE_TSLS_TSSERVER
  if (!cli || !tsserver) {
    console.error('[typescript] missing UNIVERSE_TSLS_CLI / UNIVERSE_TSLS_TSSERVER; not activating')
    return
  }

  const diagnostics = languages.createDiagnosticCollection('typescript')
  const client = new LspClient(cli, tsserver, workspace.rootPath, (e) => {
    diagnostics.set(uriComponents(e.uri), e.diagnostics)
  })

  context.subscriptions.push(diagnostics, { dispose: () => client.dispose() })

  registerProviders(context, client)
  registerDocumentSync(context, client)

  // Prewarm: spawn tsserver now (every provider needs it) and pin a seed file
  // open so the workspace project actually loads — without an open TS/JS file
  // tsserver has no project and workspace/symbol throws "No Project". This makes
  // symbols searchable before the user opens any editor.
  void prewarm(client)
}

/**
 * Eager-start tsserver and, if the workspace has a TS/JS file, pin it open to
 * force the project to load. Best-effort: any failure leaves the plugin working
 * lazily (first real request still spawns the server).
 */
async function prewarm(client: LspClient): Promise<void> {
  await client.ensureReady()
  const root = workspace.rootPath
  if (!root) return
  const seed = await findSeedFile(root)
  if (!seed) return
  try {
    const bytes = await workspace.fs.readFile(seed.path)
    const text = new TextDecoder().decode(bytes)
    await client.pinProject(URI.file(seed.path).toString(), seed.languageId, text)
  } catch (err) {
    console.error(`[typescript] prewarm pin failed: ${(err as Error).message}`)
  }
}

/** Breadth-first hunt for the first TS/JS file under `root`, skipping heavy dirs
 *  and bounded by PREWARM_MAX_DIRS so a large tree can't stall startup. */
async function findSeedFile(
  root: string,
): Promise<{ path: string; languageId: string } | undefined> {
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < PREWARM_MAX_DIRS) {
    const dir = queue.shift() as string
    visited++
    let entries: [string, FileType][]
    try {
      entries = await workspace.fs.readDirectory(dir)
    } catch {
      continue
    }
    const subdirs: string[] = []
    for (const [name, type] of entries) {
      const full = `${dir}/${name}`
      if (type === FileType.File) {
        const languageId = LANGUAGE_BY_EXT[extname(name)]
        if (languageId) return { path: full, languageId }
      } else if (type === FileType.Directory && !PREWARM_SKIP_DIRS.has(name)) {
        subdirs.push(full)
      }
    }
    queue.push(...subdirs)
  }
  return undefined
}

/** Lowercased extension incl. the dot, or '' when none. */
function extname(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function registerProviders(context: ExtensionContext, client: LspClient): void {
  context.subscriptions.push(
    languages.registerDefinitionProvider(TS_JS_LANGUAGES, {
      provideDefinition: (doc, position) => client.provideDefinition(uriString(doc.uri), position),
    }),
    languages.registerReferenceProvider(TS_JS_LANGUAGES, {
      provideReferences: (doc, position, ctx) =>
        client.provideReferences(uriString(doc.uri), position, ctx.includeDeclaration),
    }),
    languages.registerImplementationProvider(TS_JS_LANGUAGES, {
      provideImplementation: (doc, position) =>
        client.provideImplementation(uriString(doc.uri), position),
    }),
    languages.registerTypeDefinitionProvider(TS_JS_LANGUAGES, {
      provideTypeDefinition: (doc, position) =>
        client.provideTypeDefinition(uriString(doc.uri), position),
    }),
    languages.registerHoverProvider(TS_JS_LANGUAGES, {
      provideHover: (doc, position) => client.provideHover(uriString(doc.uri), position),
    }),
    languages.registerCompletionItemProvider(
      TS_JS_LANGUAGES,
      {
        provideCompletionItems: (doc, position, ctx: CompletionContext) =>
          client.provideCompletion(uriString(doc.uri), position, ctx),
        resolveCompletionItem: (item) => client.resolveCompletion(item),
      },
      ...COMPLETION_TRIGGER_CHARACTERS,
    ),
    languages.registerSignatureHelpProvider(
      TS_JS_LANGUAGES,
      {
        provideSignatureHelp: (doc, position, ctx: SignatureHelpContext) =>
          client.provideSignatureHelp(uriString(doc.uri), position, ctx),
      },
      {
        triggerCharacters: SIGNATURE_TRIGGER_CHARACTERS,
        retriggerCharacters: SIGNATURE_RETRIGGER_CHARACTERS,
      },
    ),
    languages.registerDocumentSymbolProvider(TS_JS_LANGUAGES, {
      provideDocumentSymbols: (doc) => client.provideDocumentSymbols(uriString(doc.uri)),
    }),
    languages.registerRenameProvider(TS_JS_LANGUAGES, {
      provideRenameEdits: (doc, position, newName) =>
        client.provideRenameEdits(uriString(doc.uri), position, newName),
    }),
    languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: (query) => client.provideWorkspaceSymbols(query),
    }),
  )
}

function registerDocumentSync(context: ExtensionContext, client: LspClient): void {
  const isTsJs = (doc: TextDocument): boolean => TS_JS_LANGUAGES.includes(doc.languageId)
  const open = (doc: TextDocument): void => {
    if (isTsJs(doc)) {
      void client.didOpen(uriString(doc.uri), doc.languageId, doc.version, doc.getText())
    }
  }

  // Prime the server with documents already open when the plugin activates.
  for (const doc of workspace.textDocuments) open(doc)

  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => open(doc)),
    workspace.onDidChangeTextDocument((e) => {
      if (isTsJs(e.document)) {
        void client.didChange(uriString(e.document.uri), e.document.version, e.document.getText())
      }
    }),
    workspace.onDidCloseTextDocument((doc) => {
      if (isTsJs(doc)) void client.didClose(uriString(doc.uri))
    }),
  )
}
