/**
 * Markdown language features as a built-in plugin. On activation it creates an
 * in-process markdown language service (vscode-markdown-languageservice via
 * `createMdServer`) and wires the language providers, a diagnostics collection,
 * and document sync to it — the VSCode-native shape, where markdown is just
 * another extension. No subprocess: the extension host is plain Node, so the
 * service runs directly; filesystem reads go through the gated `workspace.fs`.
 */
import {
  languages,
  workspace,
  type Diagnostic,
  type ExtensionContext,
  type TextDocument,
  type UriComponents,
} from '@universe-editor/extension-api'
import { URI } from 'vscode-uri'
import { createMdServer } from './server/mdServer.js'
import type { IMdServer } from './server/types.js'
import { createMdFsBridge } from './mdFsBridge.js'

const MARKDOWN_LANGUAGES = ['markdown']

/** Recompute-diagnostics debounce; markdown files are small, full-text each time. */
const DIDCHANGE_DEBOUNCE_MS = 200

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
  const root = workspace.rootPath ? URI.file(workspace.rootPath) : undefined
  const { server } = createMdServer(createMdFsBridge(root), root)

  const diagnostics = languages.createDiagnosticCollection('markdown')
  context.subscriptions.push(diagnostics)

  registerProviders(context, server)
  registerDocumentSync(context, server, (uri, diags) => diagnostics.set(uriComponents(uri), diags))
}

function registerProviders(context: ExtensionContext, server: IMdServer): void {
  context.subscriptions.push(
    languages.registerDocumentSymbolProvider(MARKDOWN_LANGUAGES, {
      provideDocumentSymbols: (doc) => server.$provideDocumentSymbols(uriString(doc.uri)),
    }),
    languages.registerDefinitionProvider(MARKDOWN_LANGUAGES, {
      provideDefinition: (doc, position) => server.$provideDefinition(uriString(doc.uri), position),
    }),
    languages.registerReferenceProvider(MARKDOWN_LANGUAGES, {
      provideReferences: (doc, position, ctx) =>
        server.$provideReferences(uriString(doc.uri), position, ctx.includeDeclaration),
    }),
    languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols: (query) => server.$provideWorkspaceSymbols(query),
    }),
    languages.registerFoldingRangeProvider(MARKDOWN_LANGUAGES, {
      provideFoldingRanges: (doc) => server.$provideFoldingRanges(uriString(doc.uri)),
    }),
  )
}

function registerDocumentSync(
  context: ExtensionContext,
  server: IMdServer,
  publish: (uri: string, diagnostics: readonly Diagnostic[]) => void,
): void {
  const isMarkdown = (doc: TextDocument): boolean => MARKDOWN_LANGUAGES.includes(doc.languageId)
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const refreshDiagnostics = async (uri: string): Promise<void> => {
    const diags = await server.$computeDiagnostics(uri)
    publish(uri, diags)
  }

  const scheduleDiagnostics = (uri: string): void => {
    const existing = timers.get(uri)
    if (existing) clearTimeout(existing)
    timers.set(
      uri,
      setTimeout(() => {
        timers.delete(uri)
        void refreshDiagnostics(uri)
      }, DIDCHANGE_DEBOUNCE_MS),
    )
  }

  const open = (doc: TextDocument): void => {
    if (!isMarkdown(doc)) return
    const uri = uriString(doc.uri)
    void server
      .$didOpen({ uri, version: doc.version, text: doc.getText() })
      .then(() => refreshDiagnostics(uri))
  }

  // Prime the service with documents already open when the plugin activates.
  for (const doc of workspace.textDocuments) open(doc)

  context.subscriptions.push(
    workspace.onDidOpenTextDocument((doc) => open(doc)),
    workspace.onDidChangeTextDocument((e) => {
      if (!isMarkdown(e.document)) return
      const uri = uriString(e.document.uri)
      void server.$didChange({ uri, version: e.document.version, text: e.document.getText() })
      scheduleDiagnostics(uri)
    }),
    workspace.onDidCloseTextDocument((doc) => {
      if (!isMarkdown(doc)) return
      const uri = uriString(doc.uri)
      const timer = timers.get(uri)
      if (timer) {
        clearTimeout(timer)
        timers.delete(uri)
      }
      void server.$didClose(uri)
      publish(uri, [])
    }),
    {
      dispose: () => {
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
      },
    },
  )
}
