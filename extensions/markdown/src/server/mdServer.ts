/**
 * Builds the IMdServer implementation: a markdown-it parser + the
 * vscode-markdown-languageservice over a document overlay. Runs in-process in
 * the extension host (no subprocess / stdio) and returns standard LSP types
 * directly. Factored into a `createMdServer` factory so it can be unit-tested
 * with a stub IMdClient.
 */
import MarkdownIt from 'markdown-it'
import { CancellationToken } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import {
  createLanguageService,
  DiagnosticLevel,
  githubSlugifier,
  LogLevel,
  type DiagnosticOptions,
  type ILogger,
  type IMdParser,
  type Token,
} from 'vscode-markdown-languageservice'
import type { Location } from 'vscode-languageserver-types'
import { type IMdClient, type IMdServer } from './types.js'
import { DocumentStore } from './documentStore.js'
import { LspWorkspace } from './lspWorkspace.js'

export interface MdServerHandle {
  readonly server: IMdServer
  readonly store: DocumentStore
}

// Broken-link diagnostics are the headline feature, so the fragment/file-link
// checks default on; noisier definition-hygiene checks stay at hint/ignore.
const DIAGNOSTIC_OPTIONS: DiagnosticOptions = {
  validateReferences: DiagnosticLevel.warning,
  validateFragmentLinks: DiagnosticLevel.warning,
  validateFileLinks: DiagnosticLevel.warning,
  validateMarkdownFileLinkFragments: DiagnosticLevel.warning,
  validateUnusedLinkDefinitions: DiagnosticLevel.hint,
  validateDuplicateLinkDefinitions: DiagnosticLevel.warning,
  ignoreLinks: [],
}

export function createMdServer(client: IMdClient, root: URI | undefined): MdServerHandle {
  const store = new DocumentStore()
  const workspace = new LspWorkspace(store, root, client)

  const mdIt = MarkdownIt({ html: true, linkify: true })
  const parser: IMdParser = {
    slugifier: githubSlugifier,
    tokenize: (document) =>
      Promise.resolve(mdIt.parse(document.getText(), {}) as unknown as Token[]),
  }

  const logger: ILogger = {
    get level() {
      return LogLevel.Off
    },
    log() {
      /* diagnostics silenced; flip to console.error for debugging */
    },
  }

  const ls = createLanguageService({
    workspace,
    parser,
    logger,
    markdownFileExtensions: ['md', 'markdown'],
  })

  const resolveDoc = async (uri: string) =>
    store.get(uri) ?? (await workspace.openMarkdownDocument(URI.parse(uri)))

  const server: IMdServer = {
    $didOpen: (doc) => {
      store.open(doc.uri, doc.version, doc.text)
      return Promise.resolve()
    },
    $didChange: (doc) => {
      store.change(doc.uri, doc.version, doc.text)
      return Promise.resolve()
    },
    $didClose: (uri) => {
      store.close(uri)
      return Promise.resolve()
    },

    $provideDocumentSymbols: async (uri) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      return ls.getDocumentSymbols(doc, {}, CancellationToken.None)
    },

    $provideDefinition: async (uri, position) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      const def = await ls.getDefinition(doc, position, CancellationToken.None)
      if (!def) return []
      return (Array.isArray(def) ? def : [def]) as Location[]
    },

    $provideReferences: async (uri, position, includeDeclaration) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      return ls.getReferences(doc, position, { includeDeclaration }, CancellationToken.None)
    },

    $provideWorkspaceSymbols: async (query) =>
      ls.getWorkspaceSymbols(query, CancellationToken.None),

    $provideFoldingRanges: async (uri) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      return ls.getFoldingRanges(doc, CancellationToken.None)
    },

    $computeDiagnostics: async (uri) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      return ls.computeDiagnostics(doc, DIAGNOSTIC_OPTIONS, CancellationToken.None)
    },
  }

  return { server, store }
}
