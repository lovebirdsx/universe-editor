/**
 * Builds the IMdServer implementation: a markdown-it parser + the
 * vscode-markdown-languageservice over a document overlay, with lsp→wire DTO
 * conversion. Factored out of bootstrap.ts so it can be unit-tested with a fake
 * IMdClient (no subprocess / stdio).
 */
import MarkdownIt from 'markdown-it'
import {
  CancellationToken,
  type Definition as LspDefinition,
  type Diagnostic as LspDiagnostic,
  type DocumentSymbol as LspDocumentSymbol,
  type Location as LspLocation,
  type Range as LspRange,
  type WorkspaceSymbol as LspWorkspaceSymbol,
} from 'vscode-languageserver-protocol'
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
import {
  type IMdClient,
  type IMdServer,
  type MdDiagnostic,
  type MdDocumentSymbol,
  type MdLocation,
  type MdPosition,
  type MdRange,
  type MdWorkspaceSymbol,
} from './protocol.js'
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

// #region lsp → wire DTO converters (both are 0-based; structural mapping)

const ZERO_RANGE: MdRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

const toMdRange = (r: LspRange): MdRange => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
})

const toMdLocation = (l: LspLocation): MdLocation => ({ uri: l.uri, range: toMdRange(l.range) })

const toMdSymbol = (s: LspDocumentSymbol): MdDocumentSymbol => ({
  name: s.name,
  ...(s.detail !== undefined ? { detail: s.detail } : {}),
  kind: s.kind,
  range: toMdRange(s.range),
  selectionRange: toMdRange(s.selectionRange),
  ...(s.children ? { children: s.children.map(toMdSymbol) } : {}),
})

const toMdWorkspaceSymbol = (s: LspWorkspaceSymbol): MdWorkspaceSymbol => {
  const location: MdLocation =
    'range' in s.location ? toMdLocation(s.location) : { uri: s.location.uri, range: ZERO_RANGE }
  return {
    name: s.name,
    kind: s.kind,
    location,
    ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
  }
}

const toMdLocations = (def: LspDefinition | undefined | null): MdLocation[] => {
  if (!def) return []
  return Array.isArray(def) ? def.map(toMdLocation) : [toMdLocation(def)]
}

const toMdDiagnostic = (d: LspDiagnostic): MdDiagnostic => ({
  range: toMdRange(d.range),
  message: typeof d.message === 'string' ? d.message : d.message.value,
  severity: d.severity ?? 1,
  ...(d.code !== undefined ? { code: d.code as string | number } : {}),
  ...(d.source !== undefined ? { source: d.source } : {}),
})

const positionFrom = (p: MdPosition) => ({ line: p.line, character: p.character })

// #endregion

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
    $ping: () => Promise.resolve('pong'),

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
      const syms = await ls.getDocumentSymbols(doc, {}, CancellationToken.None)
      return syms.map(toMdSymbol)
    },

    $provideDefinition: async (uri, position) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      const def = await ls.getDefinition(doc, positionFrom(position), CancellationToken.None)
      return toMdLocations(def)
    },

    $provideReferences: async (uri, position, includeDeclaration) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      const refs = await ls.getReferences(
        doc,
        positionFrom(position),
        { includeDeclaration },
        CancellationToken.None,
      )
      return refs.map(toMdLocation)
    },

    $provideWorkspaceSymbols: async (query) => {
      const syms = await ls.getWorkspaceSymbols(query, CancellationToken.None)
      return syms.map(toMdWorkspaceSymbol)
    },

    $computeDiagnostics: async (uri) => {
      const doc = await resolveDoc(uri)
      if (!doc) return []
      const diags = await ls.computeDiagnostics(doc, DIAGNOSTIC_OPTIONS, CancellationToken.None)
      return diags.map(toMdDiagnostic)
    },
  }

  return { server, store }
}
