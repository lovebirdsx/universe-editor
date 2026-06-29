/**
 * Markdown language features as a built-in plugin. On activation it creates an
 * in-process markdown language service (vscode-markdown-languageservice via
 * `createMdServer`) and wires the language providers, a diagnostics collection,
 * and document sync to it — the VSCode-native shape, where markdown is just
 * another extension. No subprocess: the extension host is plain Node, so the
 * service runs directly; filesystem reads go through the gated `workspace.fs`.
 */
import {
  commands,
  languages,
  window,
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
import { registerEditingCommands, MARKDOWN_COMMANDS } from './edit/commands.js'

const MARKDOWN_LANGUAGES = ['markdown']

// Triggers markdown path/anchor completion: `[`/`(` open a link, `#` an anchor,
// `/` a path segment.
const COMPLETION_TRIGGER_CHARACTERS = ['[', '(', '#', '/']

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
  registerEditingCommands(context)
  registerServerCommands(context, server)
}

/** Commands that need the language server (vs. the pure text-editing commands). */
function registerServerCommands(context: ExtensionContext, server: IMdServer): void {
  context.subscriptions.push(
    commands.registerCommand(MARKDOWN_COMMANDS.organizeLinkDefinitions, async () => {
      const editor = await window.getActiveTextEditor()
      if (!editor || editor.document.languageId !== 'markdown') return
      const edits = await server.$organizeLinkDefinitions(uriString(editor.document.uri))
      if (edits.length === 0) return
      await editor.edit((builder) => {
        for (const e of edits) builder.replace(e.range, e.newText)
      })
    }),
    // Invoked by the renderer (explorer/editor "Find File References"), which
    // hosts the references peek; here we only resolve the locations.
    commands.registerCommand(MARKDOWN_COMMANDS.getFileReferences, (uri: unknown) =>
      typeof uri === 'string' ? server.$getFileReferences(uri) : [],
    ),
  )
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
    languages.registerHoverProvider(MARKDOWN_LANGUAGES, {
      provideHover: (doc, position) => server.$provideHover(uriString(doc.uri), position),
    }),
    languages.registerCompletionItemProvider(
      MARKDOWN_LANGUAGES,
      {
        provideCompletionItems: (doc, position) =>
          server.$provideCompletion(uriString(doc.uri), position),
      },
      ...COMPLETION_TRIGGER_CHARACTERS,
    ),
    languages.registerRenameProvider(MARKDOWN_LANGUAGES, {
      provideRenameEdits: (doc, position, newName) =>
        server.$provideRenameEdits(uriString(doc.uri), position, newName),
    }),
    languages.registerDocumentLinkProvider(MARKDOWN_LANGUAGES, {
      provideDocumentLinks: (doc) => server.$provideDocumentLinks(uriString(doc.uri)),
      resolveDocumentLink: (link) => server.$resolveDocumentLink(link),
    }),
    languages.registerDocumentHighlightProvider(MARKDOWN_LANGUAGES, {
      provideDocumentHighlights: (doc, position) =>
        server.$provideDocumentHighlights(uriString(doc.uri), position),
    }),
    languages.registerSelectionRangeProvider(MARKDOWN_LANGUAGES, {
      provideSelectionRanges: (doc, positions) =>
        server.$provideSelectionRanges(uriString(doc.uri), positions),
    }),
    languages.registerCodeActionsProvider(MARKDOWN_LANGUAGES, {
      provideCodeActions: (doc, range, ctx) =>
        server.$provideCodeActions(uriString(doc.uri), range, ctx.only ?? []),
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
