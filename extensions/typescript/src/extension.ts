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
  type CompletionContext,
  type ExtensionContext,
  type SignatureHelpContext,
  type TextDocument,
  type UriComponents,
} from '@universe-editor/extension-api'
import { URI } from 'vscode-uri'
import { LspClient } from './lspClient.js'

const TS_JS_LANGUAGES = ['typescript', 'javascript', 'typescriptreact', 'javascriptreact']

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
