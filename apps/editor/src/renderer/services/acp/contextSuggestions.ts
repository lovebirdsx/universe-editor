/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Data sources behind the `#`-context popover. Each provider normalizes one
 *  PromptContextRefKind into ContextSuggestionItem[]; the popover owns keystroke
 *  debounce, grouping and rendering — these are headless query() calls.
 *--------------------------------------------------------------------------------------------*/

import type { ISourceControlResourceStateDto } from '@universe-editor/extensions-common'
import {
  IEditorGroupsService,
  IUriIdentityService,
  IWorkspaceService,
  URI,
  localize,
} from '@universe-editor/platform'
import { fuzzyScore } from '@universe-editor/workbench-ui'
import type { SupportedLocale } from '../../../shared/i18n/availableLocales.js'
import { IDocsService } from '../../../shared/ipc/docsService.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { resolveDocsLocale } from '../editor/docRegistry.js'
import { MonacoLoader } from '../../workbench/editor/monaco/MonacoLoader.js'
import { symbolIconId } from '../../workbench/symbols/symbolIcon.js'
import { IScmService } from '../extensions/ScmService.js'
import { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import {
  workspaceSymbolsToEntries,
  type WorkspaceSymbolEntry,
} from '../languageFeatures/typescript/lspMonacoConvert.js'
import { resourceIconId } from '../quickInput/quickPickResourceIcon.js'
import { badgeLetter } from '../scm/ScmDecorationsService.js'
import type { PromptContextRefKind } from './promptContextRef.js'

export interface ContextSuggestionItem {
  readonly kind: PromptContextRefKind
  readonly label: string
  readonly uri: string
  readonly description: string
  readonly iconId: string
  readonly meta?: {
    readonly line?: number
    readonly column?: number
    readonly symbolKind?: number
    readonly scmStatus?: string
  }
}

const MAX_RESULTS = 50

// Only surface symbols worth navigating to — the container-level declarations a
// user references with `#`. Local variables/constants/fields/properties/enum
// members and other fine-grained kinds are dropped as noise, matching VSCode
// Copilot's `#` symbol picker. Values are Monaco 0-based SymbolKind (see
// symbolIcon.ts): Module/Namespace/Package/Class/Method/Constructor/Enum/
// Interface/Function/Struct/Event.
const NAVIGABLE_SYMBOL_KINDS = new Set<number>([1, 2, 3, 4, 5, 8, 9, 10, 11, 22, 23])
// Markdown headings ride in as SymbolKind.String (14) with a markdown uri.
const STRING_SYMBOL_KIND = 14
// Headings longer than this are skipped — a long prose heading is a poor pill
// and clutters the list (VSCode omits them too).
const MAX_MARKDOWN_HEADING_LENGTH = 60

function isMarkdownUri(uri: URI): boolean {
  return uri.path.endsWith('.md')
}

/** Whether a workspace symbol is worth offering as a `#` reference. */
function isNavigableSymbol(entry: WorkspaceSymbolEntry): boolean {
  const uri = URI.parse(entry.uri.toString())
  if (entry.kind === STRING_SYMBOL_KIND && isMarkdownUri(uri)) {
    return entry.name.length <= MAX_MARKDOWN_HEADING_LENGTH
  }
  return NAVIGABLE_SYMBOL_KINDS.has(entry.kind)
}

function relativePath(root: URI | undefined, uri: URI, uriIdentity: IUriIdentityService): string {
  if (!root) return uri.fsPath
  return uriIdentity.relativePathUnder(root.fsPath, uri.fsPath) ?? uri.fsPath
}

function toItem(
  entry: WorkspaceSymbolEntry,
  root: URI | undefined,
  uriIdentity: IUriIdentityService,
): ContextSuggestionItem {
  const uri = URI.parse(entry.uri.toString())
  const line = entry.range.startLineNumber
  const column = entry.range.startColumn
  const languageId = uri.path.endsWith('.md') ? 'markdown' : undefined
  return {
    kind: 'symbol',
    label: entry.name,
    uri: uri.toString(),
    description: `${relativePath(root, uri, uriIdentity)}:${line}`,
    iconId: symbolIconId(entry.kind, languageId),
    meta: { line, column, symbolKind: entry.kind },
  }
}

/**
 * Workspace symbol source for the `#` panel's "符号" group. Mirrors
 * WorkspaceSymbolQuickAccessProvider's empty-query stale-while-revalidate cache
 * and fuzzy ranking, minus the quick-pick UI: callers own keystroke debounce.
 */
export class WorkspaceSymbolContextProvider {
  private _seq = 0
  private _emptyCache:
    | { readonly rootKey: string; readonly entries: readonly WorkspaceSymbolEntry[] }
    | undefined

  constructor(
    @ILanguageFeaturesService private readonly _langFeatures: ILanguageFeaturesService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {}

  async query(query: string): Promise<readonly ContextSuggestionItem[]> {
    const root = this._workspace.current?.folder
    const rootKey = root?.toString() ?? ''
    const trimmed = query.trim()
    const mySeq = ++this._seq

    if (!trimmed && this._emptyCache?.rootKey === rootKey) {
      const cached = this._emptyCache.entries
      // Stale-while-revalidate: serve the cached match-all list instantly, then
      // refresh it in the background for the *next* empty-query call. Skip the
      // write if a newer query() has since superseded this refresh.
      void this._fetchEntries('').then((flat) => {
        if (mySeq === this._seq) this._emptyCache = { rootKey, entries: flat }
      })
      return this._rank(cached, '', root)
    }

    const flat = await this._fetchEntries(trimmed)
    if (!trimmed && mySeq === this._seq) this._emptyCache = { rootKey, entries: flat }
    return this._rank(flat, trimmed, root)
  }

  private async _fetchEntries(query: string): Promise<readonly WorkspaceSymbolEntry[]> {
    const ns = await MonacoLoader.ensureInitialized()
    const providers = this._langFeatures.getWorkspaceSymbolProviders()
    const perProvider = await Promise.all(
      providers.map((p) =>
        p
          .provideWorkspaceSymbols(query)
          .then((symbols) => workspaceSymbolsToEntries(symbols, ns))
          .catch(() => [] as WorkspaceSymbolEntry[]),
      ),
    )
    return perProvider.flat()
  }

  private _rank(
    entries: readonly WorkspaceSymbolEntry[],
    query: string,
    root: URI | undefined,
  ): readonly ContextSuggestionItem[] {
    const navigable = entries.filter(isNavigableSymbol)
    if (!query) {
      const sorted = [...navigable].sort(
        (a, b) => a.name.localeCompare(b.name) || a.uri.toString().localeCompare(b.uri.toString()),
      )
      return sorted.slice(0, MAX_RESULTS).map((e) => toItem(e, root, this._uriIdentity))
    }
    return navigable
      .map((entry) => {
        const res = fuzzyScore(entry.name, query)
        return res ? { entry, score: res.score } : undefined
      })
      .filter((x): x is { entry: WorkspaceSymbolEntry; score: number } => x !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => toItem(x.entry, root, this._uriIdentity))
  }
}

function toScmItem(
  res: ISourceControlResourceStateDto,
  root: URI | undefined,
  uriIdentity: IUriIdentityService,
): ContextSuggestionItem {
  const uri = URI.file(res.resourceUri)
  const letter = badgeLetter(res.contextValue ?? 'M')
  return {
    kind: 'scmChange',
    label: relativePath(root, uri, uriIdentity),
    uri: uri.toString(),
    description: letter,
    // File-type icon (matching VSCode Copilot's `#` picker); the status letter
    // rides along in `description`/`meta` for the row's trailing column.
    iconId: resourceIconId(uri),
    meta: { scmStatus: letter },
  }
}

/** Empty query: alphabetical by label. Non-empty: fuzzy-ranked, non-matches dropped. */
function rankItems(
  items: readonly ContextSuggestionItem[],
  query: string,
): readonly ContextSuggestionItem[] {
  if (!query) {
    return [...items]
      .sort((a, b) => a.label.localeCompare(b.label) || a.uri.localeCompare(b.uri))
      .slice(0, MAX_RESULTS)
  }
  return items
    .map((item) => {
      const res = fuzzyScore(item.label, query)
      return res ? { item, score: res.score } : undefined
    })
    .filter((x): x is { item: ContextSuggestionItem; score: number } => x !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((x) => x.item)
}

/**
 * Local Git changes source for the `#` panel's "本地修改" group. Folds every
 * source control's working-tree resources into one path-deduped list — a
 * later group (working tree) overrides an earlier one (staged) for the same
 * path, matching ScmDecorationsService's precedence.
 */
export class ScmChangeContextProvider {
  constructor(
    @IScmService private readonly _scm: IScmService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {}

  async query(query: string): Promise<readonly ContextSuggestionItem[]> {
    return rankItems(this._collect(), query.trim())
  }

  private _collect(): readonly ContextSuggestionItem[] {
    const byPath = new Map<string, ContextSuggestionItem>()
    for (const sc of this._scm.sourceControls.get()) {
      const root = sc.rootUri !== undefined ? URI.file(sc.rootUri) : undefined
      for (const group of sc.groups.get()) {
        for (const res of group.resources.get()) {
          byPath.set(res.resourceUri, toScmItem(res, root, this._uriIdentity))
        }
      }
    }
    return [...byPath.values()]
  }
}

function toOpenEditorItem(
  uri: URI,
  root: URI | undefined,
  uriIdentity: IUriIdentityService,
): ContextSuggestionItem {
  const rel = relativePath(root, uri, uriIdentity)
  return {
    kind: 'openEditor',
    label: rel,
    uri: uri.toString(),
    description: rel,
    iconId: resourceIconId(uri),
  }
}

/**
 * Open-editors source for the `#` panel's "打开的编辑器" group. Enumerates every
 * FileEditorInput across every editor group, deduped by URI comparison key
 * (the same tab open in two split groups counts once).
 */
export class OpenEditorContextProvider {
  constructor(
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
  ) {}

  async query(query: string): Promise<readonly ContextSuggestionItem[]> {
    return rankItems(this._collect(), query.trim())
  }

  private _collect(): readonly ContextSuggestionItem[] {
    const root = this._workspace.current?.folder
    const seen = new Set<string>()
    const items: ContextSuggestionItem[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!(editor instanceof FileEditorInput)) continue
        const key = this._uriIdentity.getComparisonKey(editor.resource)
        if (seen.has(key)) continue
        seen.add(key)
        items.push(toOpenEditorItem(editor.resource, root, this._uriIdentity))
      }
    }
    return items
  }
}

// Query substrings that surface the single docs entry — a progressive prefix of
// any of these (typed char by char) keeps matching as the user types.
const DOCS_MATCH_KEYWORDS = ['docs', 'doc', '文档', '帮助', '使用', '编辑器']

function matchesDocsQuery(query: string): boolean {
  const q = query.toLowerCase()
  return DOCS_MATCH_KEYWORDS.some((k) => k.toLowerCase().includes(q))
}

/** Absolute fsPath of a locale subdirectory under the docs root (platform-native separators). */
function joinLocale(root: string, locale: SupportedLocale): string {
  return URI.joinPath(URI.file(root), locale).fsPath
}

function toDocsItem(root: string, localeDir: string | undefined): ContextSuggestionItem {
  const label = localize('acp.contextRef.docs.label', 'Editor User Guide')
  // Point at the locale subdirectory that actually holds translated docs (never
  // the parent root, whose sibling locale dirs may be empty) so the agent reads
  // the guide in one hop instead of probing an untranslated locale first.
  const target = localeDir ?? root
  const description = localize('acp.contextRef.docs.description', 'Located at {path}', {
    path: target,
  })
  return {
    kind: 'docs',
    label,
    uri: URI.file(target).toString(),
    description,
    iconId: 'docs',
  }
}

/**
 * User documentation source for the `#` panel's "文档" group. Unlike the other
 * providers this is a single whole-entry shortcut (not per-file results): it
 * surfaces one item pointing at the docs root when the query is empty or looks
 * like it's asking for docs/help, per plan §4.
 */
export class DocsContextProvider {
  constructor(@IDocsService private readonly _docs: IDocsService) {}

  async query(query: string): Promise<readonly ContextSuggestionItem[]> {
    const trimmed = query.trim()
    if (trimmed && !matchesDocsQuery(trimmed)) return []
    const root = await this._docs.getDocsRoot()
    const locale = resolveDocsLocale()
    const localeDir = locale ? joinLocale(root, locale) : undefined
    return [toDocsItem(root, localeDir)]
  }
}

// Same progressive-prefix trick as DOCS_MATCH_KEYWORDS.
const COMMIT_MATCH_KEYWORDS = ['commit', 'commits', 'git log', '提交', '历史', 'commit记录']

function matchesCommitQuery(query: string): boolean {
  const q = query.toLowerCase()
  return COMMIT_MATCH_KEYWORDS.some((k) => k.toLowerCase().includes(q))
}

function toCommitPickerItem(): ContextSuggestionItem {
  return {
    kind: 'commit',
    label: localize('acp.contextRef.commit.label', 'Git Commit…'),
    uri: '',
    description: localize('acp.contextRef.commit.description', 'Pick a commit from history'),
    iconId: 'git-commit',
  }
}

/**
 * Git-history source for the `#` panel's "提交" group. Like DocsContextProvider
 * this surfaces a single entry point rather than per-commit results — picking
 * it opens a follow-up QuickPick (see commitRefPicker.ts) that lists the
 * currently-selected repo's commit history.
 */
export class CommitContextProvider {
  constructor(@IScmService private readonly _scm: IScmService) {}

  async query(query: string): Promise<readonly ContextSuggestionItem[]> {
    if (this._scm.sourceControls.get().length === 0) return []
    const trimmed = query.trim()
    if (trimmed && !matchesCommitQuery(trimmed)) return []
    return [toCommitPickerItem()]
  }
}
