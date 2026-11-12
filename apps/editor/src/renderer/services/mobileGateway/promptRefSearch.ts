/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Phone-side `@` / `#` completion. Reuses the desktop prompt-input data sources
 *  headlessly (file listing, workspace symbols, SCM changes, open editors,
 *  built-in docs) and normalizes them to the wire DTO. Sessions rooted in a
 *  subdirectory narrow every path-bearing source to that directory, mirroring
 *  the desktop popover; docs live outside the workspace and are never narrowed.
 *
 *  Budgets are deliberately smaller than the gateway's 10s command deadline:
 *  a stale phone query is worthless, and a slow source must degrade to fewer
 *  suggestions instead of failing the whole command.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  URI,
  type CancellationToken,
  type IEditorGroupsService,
  type IFileSearchService,
  type IUriIdentityService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import {
  clampText,
  MAX_PROMPT_REF_DESCRIPTION_LENGTH,
  MAX_PROMPT_REF_DIR_PATH_LENGTH,
  MAX_PROMPT_REF_LABEL_LENGTH,
  MAX_PROMPT_REF_STATUS_LENGTH,
  MAX_PROMPT_REF_SUGGESTIONS,
  MAX_PROMPT_REF_URI_LENGTH,
  type MobilePromptRefSuggestion,
  type MobilePromptRefTrigger,
} from '@universe-editor/mobile-protocol'
import {
  filterMentionFiles,
  loadWorkspaceFiles,
  type MentionFileEntry,
} from '../acp/mentionFileSearch.js'
import {
  CommitContextProvider,
  DocsContextProvider,
  ExtensionContextProvider,
  OpenEditorContextProvider,
  ScmChangeContextProvider,
  WorkspaceSymbolContextProvider,
  type ContextSuggestionItem,
} from '../acp/contextSuggestions.js'
import type { SessionScopeRoot } from '../acp/sessionScope.js'
import { IDocsService } from '../../../shared/ipc/docsService.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IChatContextService } from '../extensions/ChatContextService.js'
import { IScmService } from '../extensions/ScmService.js'
import { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'

const FILE_LISTING_TIMEOUT_MS = 5_000
const FILE_FALLBACK_TIMEOUT_MS = 3_000
const CONTEXT_PROVIDER_TIMEOUT_MS = 6_000

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function sanitize(value: string): string {
  return value.replace(CONTROL_CHARS, ' ')
}

/**
 * Identity-bearing fields are never truncated: a clipped path or URI would be
 * echoed back on send and fail the bridge's exact rebuild check. Drop the
 * suggestion instead of handing the phone a token that can never be sent.
 */
function fitText(value: string, max: number): string | undefined {
  if (value.length === 0 || value.length > max || HAS_CONTROL_CHARS.test(value)) return undefined
  return value
}

function clampDescription(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const sanitized = sanitize(value)
  return sanitized.length === 0
    ? undefined
    : clampText(sanitized, MAX_PROMPT_REF_DESCRIPTION_LENGTH)
}

function fileSuggestion(entry: MentionFileEntry): MobilePromptRefSuggestion | undefined {
  const label = fitText(entry.relPath, MAX_PROMPT_REF_LABEL_LENGTH)
  const uri = fitText(entry.uri, MAX_PROMPT_REF_URI_LENGTH)
  if (label === undefined || uri === undefined) return undefined
  return { kind: 'file', label, uri }
}

function contextSuggestion(item: ContextSuggestionItem): MobilePromptRefSuggestion | undefined {
  const label = fitText(item.label, MAX_PROMPT_REF_LABEL_LENGTH)
  if (label === undefined) return undefined
  const description = clampDescription(item.description)
  const shared = {
    label,
    ...(description !== undefined ? { description } : {}),
  }
  switch (item.kind) {
    case 'symbol': {
      const uri = fitText(item.uri, MAX_PROMPT_REF_URI_LENGTH)
      if (uri === undefined) return undefined
      const line = item.meta?.line
      const column = item.meta?.column
      const symbolKind = item.meta?.symbolKind
      return {
        ...shared,
        kind: 'symbol',
        uri,
        ...(typeof line === 'number' && Number.isInteger(line) && line > 0 ? { line } : {}),
        ...(typeof column === 'number' && Number.isInteger(column) && column > 0 ? { column } : {}),
        ...(typeof symbolKind === 'number' && Number.isInteger(symbolKind) && symbolKind >= 0
          ? { symbolKind }
          : {}),
      }
    }
    case 'scmChange': {
      const uri = fitText(item.uri, MAX_PROMPT_REF_URI_LENGTH)
      if (uri === undefined) return undefined
      return {
        ...shared,
        kind: 'scmChange',
        uri,
        ...(item.meta?.scmStatus !== undefined
          ? { scmStatus: clampText(sanitize(item.meta.scmStatus), MAX_PROMPT_REF_STATUS_LENGTH) }
          : {}),
      }
    }
    case 'openEditor': {
      const uri = fitText(item.uri, MAX_PROMPT_REF_URI_LENGTH)
      if (uri === undefined) return undefined
      return { ...shared, kind: 'openEditor', uri }
    }
    case 'docs': {
      const uri = fitText(item.uri, MAX_PROMPT_REF_URI_LENGTH)
      if (uri === undefined) return undefined
      const dirPath = item.meta?.dirPath
      if (dirPath === undefined) return undefined
      const fitted = fitText(dirPath, MAX_PROMPT_REF_DIR_PATH_LENGTH)
      if (fitted === undefined) return undefined
      return { ...shared, kind: 'docs', uri, dirPath: fitted }
    }
    case 'commit':
      return { ...shared, kind: 'commit', uri: '' }
    case 'chatContext': {
      const handle = item.meta?.chatContextHandle
      if (typeof handle !== 'number' || !Number.isInteger(handle) || handle < 1) return undefined
      return { ...shared, kind: 'chatContext', uri: '', chatContextHandle: handle }
    }
    default:
      return undefined
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

interface ContextProviders {
  readonly symbol: WorkspaceSymbolContextProvider
  readonly scmChange: ScmChangeContextProvider
  readonly openEditor: OpenEditorContextProvider
  readonly docs: DocsContextProvider
  readonly commit: CommitContextProvider
  readonly chatContext: ExtensionContextProvider
}

export interface PromptRefSearchDeps {
  readonly fileSearch: IFileSearchService
  readonly exclude: IExcludeService
  readonly workspace: IWorkspaceService
  readonly editorGroups: IEditorGroupsService
  readonly scm: IScmService
  readonly uriIdentity: IUriIdentityService
  readonly langFeatures: ILanguageFeaturesService
  readonly docs: IDocsService
  readonly chatContext: IChatContextService
}

export class MobilePromptRefSearch {
  private _providers: ContextProviders | undefined

  constructor(private readonly _deps: PromptRefSearchDeps) {}

  async search(
    scope: SessionScopeRoot,
    trigger: MobilePromptRefTrigger,
    query: string,
    limit: number,
    token?: CancellationToken,
  ): Promise<readonly MobilePromptRefSuggestion[]> {
    const capped = Math.max(1, Math.min(limit, MAX_PROMPT_REF_SUGGESTIONS))
    return trigger === '@'
      ? this._searchFiles(scope.root, query, capped, token)
      : this._searchContext(scope, query, capped, token)
  }

  private async _searchFiles(
    root: URI,
    query: string,
    limit: number,
    token: CancellationToken | undefined,
  ): Promise<readonly MobilePromptRefSuggestion[]> {
    const { fileSearch, exclude } = this._deps
    const listing = await loadWorkspaceFiles(
      root,
      fileSearch,
      {
        dirNames: exclude.getDirNameIgnores(),
        excludeGlobs: exclude.getSearchExcludeGlobs(),
        useIgnoreFiles: exclude.getUseIgnoreFiles(),
        timeoutMs: FILE_LISTING_TIMEOUT_MS,
      },
      token,
    )
    if (token?.isCancellationRequested) return []
    let entries = filterMentionFiles(listing.entries, query, limit)
    // The truncated listing is an arbitrary subset, so a query may match files
    // the walk never saw (mirrors the desktop input's fallback). An empty query
    // only falls back when the listing itself produced nothing.
    if (!listing.complete && (query.length > 0 || entries.length === 0)) {
      const fallback = await this._fallbackFiles(root, query, limit, token)
      if (token?.isCancellationRequested) return []
      const seen = new Set(entries.map((entry) => entry.uri))
      entries = filterMentionFiles(
        [...entries, ...fallback.filter((entry) => !seen.has(entry.uri))],
        query,
        limit,
      )
    }
    return entries
      .map(fileSuggestion)
      .filter((entry): entry is MobilePromptRefSuggestion => entry !== undefined)
  }

  private async _fallbackFiles(
    root: URI,
    query: string,
    limit: number,
    token: CancellationToken | undefined,
  ): Promise<readonly MentionFileEntry[]> {
    const { fileSearch, exclude } = this._deps
    const cts = new CancellationTokenSource(token)
    const timer = setTimeout(() => cts.dispose(true), FILE_FALLBACK_TIMEOUT_MS)
    try {
      const complete = await fileSearch.search(
        {
          root,
          pattern: query,
          ...(query.length === 0 ? { matchAll: true } : {}),
          maxResults: limit,
          ignore: exclude.getDirNameIgnores(),
          excludes: exclude.getSearchExcludeGlobs(),
          useIgnoreFiles: exclude.getUseIgnoreFiles(),
        },
        cts.token,
      )
      if ('relPaths' in complete) {
        return complete.relPaths.map((relPath) => ({
          uri: URI.joinPath(root, relPath).toString(),
          relPath,
          name: relPath.slice(relPath.lastIndexOf('/') + 1),
        }))
      }
      return complete.results.map((hit) => ({
        uri: hit.resource.toString(),
        relPath: hit.relativePath,
        name: hit.basename,
      }))
    } catch {
      return []
    } finally {
      clearTimeout(timer)
      cts.dispose(true)
    }
  }

  private async _searchContext(
    scope: SessionScopeRoot,
    query: string,
    limit: number,
    token: CancellationToken | undefined,
  ): Promise<readonly MobilePromptRefSuggestion[]> {
    const providers = this._contextProviders()
    // Mobile gates the commit entry on a real Git repo: the provider only checks
    // that some source control exists, and a P4-only workspace would otherwise
    // offer a picker that can never load commits.
    const hasGit = this._deps.scm.sourceControls
      .get()
      .some((control) => control.id === 'git' && control.rootUri !== undefined)
    const [symbol, scmChange, openEditor, docs, commit, chatContext] = await Promise.all([
      withTimeout(providers.symbol.query(query), CONTEXT_PROVIDER_TIMEOUT_MS),
      withTimeout(providers.scmChange.query(query), CONTEXT_PROVIDER_TIMEOUT_MS),
      withTimeout(providers.openEditor.query(query), CONTEXT_PROVIDER_TIMEOUT_MS),
      withTimeout(providers.docs.query(query), CONTEXT_PROVIDER_TIMEOUT_MS),
      hasGit ? withTimeout(providers.commit.query(query), CONTEXT_PROVIDER_TIMEOUT_MS) : [],
      withTimeout(providers.chatContext.query(query), CONTEXT_PROVIDER_TIMEOUT_MS),
    ])
    if (token?.isCancellationRequested === true) return []
    const scoped = (
      items: readonly ContextSuggestionItem[] | undefined,
    ): readonly ContextSuggestionItem[] => {
      if (items === undefined) return []
      if (!scope.narrowed) return items
      return items.filter((item) => {
        try {
          return this._deps.uriIdentity.isEqualOrParent(URI.parse(item.uri), scope.root)
        } catch {
          return false
        }
      })
    }
    // Fewest items first so high-signal sources surface at the top; the stable
    // sort keeps symbol → scmChange → openEditor → docs → commit → chatContext
    // on ties (same rule as the desktop popover). Docs reference app resources,
    // commit/chatContext entries carry no workspace resource, so none of them
    // are narrowed to a subdirectory session.
    const groups: readonly (readonly ContextSuggestionItem[])[] = [
      scoped(symbol),
      scoped(scmChange),
      scoped(openEditor),
      docs ?? [],
      commit ?? [],
      chatContext ?? [],
    ]
    return groups
      .filter((group) => group.length > 0)
      .sort((a, b) => a.length - b.length)
      .flatMap((group) => group)
      .slice(0, limit)
      .map(contextSuggestion)
      .filter((item): item is MobilePromptRefSuggestion => item !== undefined)
  }

  private _contextProviders(): ContextProviders {
    this._providers ??= {
      symbol: new WorkspaceSymbolContextProvider(
        this._deps.langFeatures,
        this._deps.workspace,
        this._deps.uriIdentity,
      ),
      scmChange: new ScmChangeContextProvider(
        this._deps.scm,
        this._deps.uriIdentity,
        this._deps.workspace,
      ),
      openEditor: new OpenEditorContextProvider(
        this._deps.editorGroups,
        this._deps.workspace,
        this._deps.uriIdentity,
      ),
      docs: new DocsContextProvider(this._deps.docs),
      commit: new CommitContextProvider(this._deps.scm),
      chatContext: new ExtensionContextProvider(this._deps.chatContext),
    }
    return this._providers
  }
}
