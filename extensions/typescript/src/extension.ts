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

/** Directories never worth descending into when hunting for tsconfigs / seeds. */
const PREWARM_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next'])
/** Bound the tsconfig / seed search so a huge tree can't stall prewarm. */
const PREWARM_MAX_DIRS = 400
/** Seed selection skips loose config files (eslint.config.js, vite.config.ts, …):
 *  they usually live outside any tsconfig's include, so tsserver builds an
 *  inferred project for them whose navto can't see the real workspace symbols. */
const SEED_SKIP_FILE = /\.config\.[cm]?[jt]sx?$/i

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

  // Prewarm: spawn tsserver now (every provider needs it) and pin one seed file
  // per targeted tsconfig so the workspace projects actually load — without an
  // open TS/JS file tsserver has no project and workspace/symbol throws "No
  // Project", and navto only searches the project owning an open file. This makes
  // symbols searchable before the user opens any editor. Which tsconfigs to warm
  // is driven by `typescript.prewarm.projects` (see resolvePrewarmTargets).
  void prewarm(client)
}

/** A directory-reading dependency, so the prewarm search is unit-testable. */
type ReadDir = (dir: string) => Promise<Array<[string, FileType]>>

/**
 * Eager-start tsserver and pin a seed file for each targeted tsconfig so its
 * project loads. Best-effort: any failure leaves the plugin working lazily (the
 * first real request still spawns the server and loads the file's project).
 */
async function prewarm(client: LspClient): Promise<void> {
  await client.ensureReady()
  const root = workspace.rootPath
  if (!root) return

  const readDir: ReadDir = async (dir) => {
    try {
      return await workspace.fs.readDirectory(dir)
    } catch {
      return []
    }
  }

  const allTsconfigs = await enumerateTsconfigs(root, readDir)
  const configured = await workspace
    .getConfiguration('typescript')
    .get<string[]>('prewarm.projects', [])
  const targets = resolvePrewarmTargets(allTsconfigs, configured)

  for (const tsconfigDir of targets) {
    const startDir = tsconfigDir === '' ? root : `${root}/${tsconfigDir}`
    const seed = await findSeedFile(startDir, readDir)
    if (!seed) continue
    try {
      const bytes = await workspace.fs.readFile(seed.path)
      const text = new TextDecoder().decode(bytes)
      await client.pinProject(URI.file(seed.path).toString(), seed.languageId, text)
    } catch (err) {
      console.error(`[typescript] prewarm pin failed: ${(err as Error).message}`)
    }
  }
}

/**
 * Decide which tsconfig directories to prewarm, returning the directory of each
 * target tsconfig (a seed is hunted inside it). Rules:
 * - single tsconfig in the workspace → always warm it (small projects are free);
 * - multiple tsconfigs + no config → warm none (opening a seed per project is
 *   costly, and picking one arbitrarily is worse than nothing — the user opts in);
 * - explicit config → warm exactly the listed tsconfigs that actually exist.
 * `configured` entries and enumerated paths are workspace-relative, POSIX-slashed.
 */
export function resolvePrewarmTargets(
  allTsconfigs: readonly string[],
  configured: readonly string[],
): string[] {
  const dirOf = (rel: string): string => {
    const slash = rel.lastIndexOf('/')
    return slash === -1 ? '' : rel.slice(0, slash)
  }
  const known = new Set(allTsconfigs)
  const chosen: string[] = []
  const seenDirs = new Set<string>()
  const add = (rel: string): void => {
    const dir = dirOf(rel)
    if (seenDirs.has(dir)) return
    seenDirs.add(dir)
    chosen.push(dir)
  }

  if (configured.length > 0) {
    for (const rel of configured) {
      const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '')
      if (known.has(norm)) add(norm)
    }
    return chosen
  }
  if (allTsconfigs.length === 1) {
    add(allTsconfigs[0] as string)
    return chosen
  }
  return chosen
}

/** Breadth-first enumeration of every `tsconfig*.json` under `root`, returning
 *  workspace-relative POSIX paths. Skips heavy dirs and is bounded so a large
 *  tree can't stall startup. */
export async function enumerateTsconfigs(root: string, readDir: ReadDir): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [root]
  let visited = 0
  while (queue.length > 0 && visited < PREWARM_MAX_DIRS) {
    const dir = queue.shift() as string
    visited++
    const entries = await readDir(dir)
    for (const [name, type] of entries) {
      const full = `${dir}/${name}`
      if (type === FileType.File) {
        if (/^tsconfig(\..+)?\.json$/i.test(name)) {
          found.push(relative(root, full))
        }
      } else if (type === FileType.Directory && !PREWARM_SKIP_DIRS.has(name)) {
        queue.push(full)
      }
    }
  }
  return found
}

/** Breadth-first hunt for the first real TS/JS source file under `startDir` (an
 *  absolute path), skipping heavy dirs and loose config files, so the seed
 *  belongs to a real tsconfig project (not an inferred one). */
export async function findSeedFile(
  startDir: string,
  readDir: ReadDir,
): Promise<{ path: string; languageId: string } | undefined> {
  const queue: string[] = [startDir]
  let visited = 0
  while (queue.length > 0 && visited < PREWARM_MAX_DIRS) {
    const cur = queue.shift() as string
    visited++
    const entries = await readDir(cur)
    const subdirs: string[] = []
    for (const [name, type] of entries) {
      const full = `${cur}/${name}`
      if (type === FileType.File) {
        if (SEED_SKIP_FILE.test(name)) continue
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

/** Workspace-relative POSIX path of `full` under `root`. */
function relative(root: string, full: string): string {
  const prefix = `${root}/`
  return full.startsWith(prefix) ? full.slice(prefix.length) : full
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

  // Semantic tokens re-color TextMate's guesses with real type info from tsserver
  // (e.g. an uppercase property no longer shows as a type). Monaco's getLegend()
  // is synchronous, so we must know the server's legend before registering — it
  // arrives in the initialize response, hence the deferred registration.
  void client.getSemanticTokensLegend().then((legend) => {
    if (!legend) return
    context.subscriptions.push(
      languages.registerDocumentSemanticTokensProvider(TS_JS_LANGUAGES, {
        legend,
        provideDocumentSemanticTokens: (doc) =>
          client.provideDocumentSemanticTokens(uriString(doc.uri)),
      }),
    )
  })
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
