/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `useMarkdownFileLink` — resolve and open a file path clicked inside rendered
 *  markdown. Concrete candidates (absolute, relative to the markdown source dir,
 *  relative to the workspace root) are probed first and opened on the first hit —
 *  no search, so an existing path opens instantly. Only when none exist do we
 *  fall back to a suffix-targeted resolution: first the recently opened files
 *  (the same MRU list Ctrl+P shows as "Recently Opened", so a file the user just
 *  worked in opens without a disk walk), then a live workspace enumeration (rg
 *  via the file search service), narrowed to the focus folders when focus mode
 *  is on — mirroring Ctrl+P, this keeps a giant workspace responsive. A single
 *  hit opens directly, several hits hand off to Go to File (prefilled with the
 *  path) so the user picks the intended target, and zero hits surfaces either
 *  "file not found" or, when the enumeration was truncated/timed out or limited
 *  to the focus scope, an "unable to confirm" notification. The live walk never
 *  reads the on-disk listing, so a file created after that listing was built is
 *  still found, and a giant workspace cannot stale it into a false "missing".
 *
 *  In `previewLinks` mode (the doc preview) a link to another markdown file opens
 *  as a *preview* rather than its source: the preview tab is opened pinned and
 *  deduplicated globally — an existing preview of that file is focused instead
 *  of duplicated. Links that carry a `:line` location, or point at non-markdown
 *  files, always open the source editor as before.
 *
 *  `target` (from Ctrl/Cmd or Alt held on the click) routes the open: Ctrl/Cmd
 *  sends it to the group to the right of the active one (created when the layout
 *  has none), Alt to an auxiliary window. It only takes effect where an editor
 *  is actually opened: a missing file, a multi-match handoff to Go to File and a
 *  directory target all leave the layout untouched rather than creating a group
 *  for nothing.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef } from 'react'
import {
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  ILifecycleService,
  INotificationService,
  IUriIdentityService,
  IWindowsService,
  IWorkspaceService,
  localize,
  Severity,
  ShutdownReason,
  URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import {
  openEditorAndReveal,
  revealSelectionInInput,
} from '../../services/editor/revealEditorPosition.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../../services/editor/MarkdownPreviewRegistry.js'
import { openPreviewInGroup } from '../../services/editor/openPreviewInGroup.js'
import {
  openFreshInputWithTarget,
  openSingletonWithTarget,
  openUriWithTarget,
} from '../../services/editor/openWithTarget.js'
import { ensureSideGroup } from '../../services/editor/openToSide.js'
import type { OpenTarget } from '../../services/editor/openTarget.js'
import { IAuxiliaryEditorWindowService } from '../../services/windows/auxiliaryEditorWindowService.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { IFocusScopeService } from '../../services/focus/FocusScopeService.js'
import { focusScopeForMention } from '../../services/acp/mentionFileSearch.js'
import { IRecentFilesService } from '../../services/recentFiles/recentFilesService.js'
import { IQuickAccessController } from '../../services/quickInput/QuickAccessController.js'
import { stripFilePathLinkPrefix } from '../../services/acp/filePathLink.js'
import { IWindowFocusService } from '../../services/windows/windowFocusService.js'
import { useOptionalService } from '../useService.js'
import { useWorkspaceHome } from '../useWorkspaceHome.js'
import {
  isLinkSuffixMatch,
  markdownLinkCandidates,
  searchGlobFor,
  searchPatternFor,
} from './markdownLinkResolve.js'

const CACHE_TTL = 10_000
const SEARCH_MAX_RESULTS = 50
const SEARCH_TIMEOUT_MS = 10_000

/** Outcome of resolving a clicked path: open it, let the user pick, or report it. */
type Resolution =
  | { readonly kind: 'open'; readonly uri: URI }
  | { readonly kind: 'pick'; readonly pattern: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }

type CacheEntry = { readonly resolution: Resolution; readonly expiresAt: number }

/** Options carried from the click handler (which mouse modifiers were held). */
export interface OpenMarkdownLinkOptions {
  /** Where to open: active group (default), right split, or auxiliary window. */
  readonly target?: OpenTarget
  /** Markdown heading fragment from a cross-file link (`foo.md#section`). */
  readonly fragment?: string
  /**
   * Ctrl+Alt was held (preview only — text mode can't observe Alt through
   * Monaco). For a directory target this opens the folder in the *current*
   * window instead of a new one.
   */
  readonly openFolderInCurrentWindow?: boolean
}

function isMarkdownResource(uri: URI): boolean {
  const p = uri.path.toLowerCase()
  return p.endsWith('.md') || p.endsWith('.markdown') || p.endsWith('.mdx')
}

/** Client platform, used only when the URI identity service cannot answer. */
function isWindowsClient(): boolean {
  return typeof window !== 'undefined' && window.ipc?.platform === 'win32'
}

/**
 * Recently opened files whose workspace-relative path equals or ends with
 * `pattern`, limited to files that still exist. This is the same MRU list
 * Ctrl+P renders as "Recently Opened": matching it first resolves the common
 * case (clicking a link to a file just worked in) without any disk walk.
 * Outside-workspace entries are skipped — a bare suffix is not an identity
 * there, and the concrete candidates already covered absolute paths.
 */
async function findRecentSuffixMatches(
  recentFilesService: IRecentFilesService,
  fileService: IFileService,
  workspaceRoot: URI,
  identity: IUriIdentityService,
  pattern: string,
  caseSensitive: boolean,
): Promise<URI[]> {
  const recent = await recentFilesService.getAll().catch(() => [])
  const matches: URI[] = []
  const seen = new Set<string>()
  for (const file of recent) {
    const rel = identity.relativePath(workspaceRoot, file.uri)
    if (rel === null || rel === '' || !isLinkSuffixMatch(rel, pattern, caseSensitive)) continue
    const key = identity.getComparisonKey(file.uri)
    if (seen.has(key)) continue
    seen.add(key)
    matches.push(file.uri)
  }
  if (matches.length === 0) return []
  const existing = await Promise.all(
    matches.map(async (uri) => ((await fileService.exists(uri)) ? uri : undefined)),
  )
  return existing.filter((uri): uri is URI => uri !== undefined)
}

/**
 * Returns `openFileLink(rawPath, line?, col?, endLine?, opts?)` for markdown links. The
 * path may be absolute or relative to {@link baseUri}; resolution is cached for
 * 10s and shares one in-flight promise across concurrent clicks on the same
 * path. When {@link previewLinks} is set (the doc preview), a markdown target
 * without a `:line` location opens as a preview instead of its source.
 */
export function useMarkdownFileLink(
  baseUri: URI | undefined,
  previewLinks = false,
): (
  rawPath: string,
  line?: number,
  col?: number,
  endLine?: number,
  opts?: OpenMarkdownLinkOptions,
) => void {
  const fileService = useOptionalService(IFileService)
  const fileSearchService = useOptionalService(IFileSearchService)
  const workspaceService = useOptionalService(IWorkspaceService)
  const editorService = useOptionalService(IEditorService)
  const editorResolver = useOptionalService(IEditorResolverService)
  const groupsService = useOptionalService(IEditorGroupsService)
  const instantiation = useOptionalService(IInstantiationService)
  const auxService = useOptionalService(IAuxiliaryEditorWindowService)
  const uriIdentityService = useOptionalService(IUriIdentityService)
  const notificationService = useOptionalService(INotificationService)
  const windowsService = useOptionalService(IWindowsService)
  const lifecycleService = useOptionalService(ILifecycleService)
  const excludeService = useOptionalService(IExcludeService)
  const recentFilesService = useOptionalService(IRecentFilesService)
  const focusScopeService = useOptionalService(IFocusScopeService)
  const quickAccess = useOptionalService(IQuickAccessController)
  const windowFocus = useOptionalService(IWindowFocusService)
  const cache = useRef(new Map<string, CacheEntry>())
  const inflight = useRef(new Map<string, Promise<Resolution>>())
  // Home for `~` expansion on the host the link lives on. `window.ipc.home` is the
  // *client's* os.homedir() — in a remote workspace the path belongs to the
  // remote host, so the home has to come from the workspace's authority.
  const { home: homeDir, resolveHome } = useWorkspaceHome(baseUri)

  const resolve = useCallback(
    (rawPath: string): Promise<Resolution> => {
      if (!fileService) return Promise.resolve<Resolution>({ kind: 'missing' })
      const normalizedRawPath = stripFilePathLinkPrefix(rawPath)
      const now = Date.now()
      const cached = cacheGet(cache.current, normalizedRawPath, now)
      if (cached) return Promise.resolve(cached)
      const running = inflight.current.get(normalizedRawPath)
      if (running) return running

      const promise = (async (): Promise<Resolution> => {
        const workspaceRoot = workspaceService?.current?.folder
        // The remote home arrives with the handshake, which may still be in
        // flight — expand `~` with the awaited answer rather than letting it
        // fall through as a relative path (which would miss for sure).
        const home = homeDir ?? (await resolveHome())
        // 1. Concrete candidates — open the first that exists, no search needed.
        for (const candidate of markdownLinkCandidates(
          normalizedRawPath,
          baseUri,
          workspaceRoot,
          home,
        )) {
          if (await fileService.exists(candidate)) return { kind: 'open', uri: candidate }
        }

        // 2. Recently opened files first — the same MRU list Ctrl+P shows as
        //    "Recently Opened". Clicking a link to a file the user just worked
        //    in is the common case, and it resolves without touching the disk.
        const pattern = searchPatternFor(normalizedRawPath)
        if (pattern.length === 0) return { kind: 'missing' }
        if (!workspaceRoot) return { kind: 'missing' }
        const caseSensitive =
          uriIdentityService?.isCaseSensitive(workspaceRoot) ?? !isWindowsClient()
        if (recentFilesService && uriIdentityService) {
          const recentHits = await findRecentSuffixMatches(
            recentFilesService,
            fileService,
            workspaceRoot,
            uriIdentityService,
            pattern,
            caseSensitive,
          )
          if (recentHits.length === 1) return { kind: 'open', uri: recentHits[0]! }
          if (recentHits.length > 1) return { kind: 'pick', pattern }
        }

        // 3. Live suffix enumeration over the workspace. Unlike a scored search
        //    this never reads the on-disk listing, so it sees files created
        //    after that listing was built and cannot be defeated by a huge,
        //    stale or partial listing. rg does the prefilter; the suffix check
        //    below is the definitive one. Focus mode narrows the walk to its
        //    folders (mirroring Ctrl+P), which is what keeps a multi-million-file
        //    workspace from turning the click into a minute-long scan.
        if (!fileSearchService) return { kind: 'missing' }
        const focus = focusScopeService ? focusScopeForMention(focusScopeService) : undefined
        const result = await fileSearchService.search({
          root: workspaceRoot,
          pattern: '',
          matchAll: true,
          glob: [searchGlobFor(pattern)],
          maxResults: SEARCH_MAX_RESULTS,
          omitTruncatedListing: true,
          timeoutMs: SEARCH_TIMEOUT_MS,
          ...(focus?.scanPaths !== undefined ? { scanPaths: focus.scanPaths } : {}),
          ...(focus?.rootFilesInScope === true ? { rootFilesInScope: true } : {}),
          ...(excludeService
            ? {
                excludes: excludeService.getSearchExcludeGlobs(),
                ignore: excludeService.getDirNameIgnores(),
                useIgnoreFiles: excludeService.getUseIgnoreFiles(),
              }
            : {}),
        })
        const hits = ('relPaths' in result ? result.relPaths : []).filter((rel) =>
          isLinkSuffixMatch(rel, pattern, caseSensitive),
        )
        // A truncated walk (timeout / cap / partial listing) cannot support a
        // definitive "not found". Neither can a walk limited to the focus
        // scope: the file may simply live outside it.
        if (hits.length === 0) {
          return result.limitHit || focus?.scanPaths !== undefined
            ? { kind: 'unavailable' }
            : { kind: 'missing' }
        }
        if (hits.length === 1) {
          return { kind: 'open', uri: URI.joinPath(workspaceRoot, hits[0]!) }
        }
        // Several matches: let the user disambiguate in Go to File, prefilled.
        return { kind: 'pick', pattern }
      })()

      inflight.current.set(normalizedRawPath, promise)
      void promise.then((resolution) => {
        inflight.current.delete(normalizedRawPath)
        // Only cache stable outcomes; 'missing'/'unavailable' are transient
        // (services not ready, walk truncated) and must not be pinned for 10s.
        if (resolution.kind === 'open' || resolution.kind === 'pick') {
          cache.current.set(normalizedRawPath, { resolution, expiresAt: Date.now() + CACHE_TTL })
        }
      })
      return promise
    },
    [
      fileService,
      fileSearchService,
      workspaceService,
      excludeService,
      recentFilesService,
      focusScopeService,
      uriIdentityService,
      baseUri,
      homeDir,
      resolveHome,
    ],
  )

  return useCallback(
    (
      rawPath: string,
      line?: number,
      col?: number,
      endLine?: number,
      opts?: OpenMarkdownLinkOptions,
    ) => {
      if (!editorService || !instantiation) return
      void resolve(rawPath).then(async (resolution) => {
        if (resolution.kind === 'missing') {
          notificationService?.notify({
            severity: Severity.Warning,
            message: localize('markdown.linkFileNotFound', 'File does not exist: {path}', {
              path: stripFilePathLinkPrefix(rawPath),
            }),
          })
          return
        }
        if (resolution.kind === 'unavailable') {
          notificationService?.notify({
            severity: Severity.Warning,
            message: localize(
              'markdown.linkSearchUnavailable',
              'Unable to confirm whether the file exists: {path}. Try again.',
              { path: stripFilePathLinkPrefix(rawPath) },
            ),
          })
          return
        }
        if (resolution.kind === 'pick') {
          // Hand off to Go to File so the user picks among the matches. We can't
          // carry the :line here, but multi-match links are the rare case.
          void quickAccess?.show(resolution.pattern)
          return
        }
        const uri = resolution.uri
        const target = opts?.target ?? 'default'
        // A directory can't be shown as an editor: open it as a folder. Ctrl+Alt
        // (preview only) opens it in the current window; otherwise a new window —
        // mirroring how a dropped folder is handled (openDroppedResource).
        if (await isDirectory(fileService, uri)) {
          if (opts?.openFolderInCurrentWindow && workspaceService && lifecycleService) {
            if (await lifecycleService.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)) return
            await workspaceService.openFolder(uri)
          } else {
            await windowsService?.openWindow(uri)
          }
          return
        }
        // A markdown→markdown link in the preview opens as another pinned
        // preview tab (the same-file one is focused instead — previews are
        // globally unique), in the side group or an auxiliary window when a
        // modified click asked for it. A `:line` location means the user wants
        // the source at that line, so fall through.
        if (previewLinks && groupsService && line === undefined && isMarkdownResource(uri)) {
          const preview = new MarkdownPreviewInput(uri)
          if (target !== 'default' && instantiation && auxService && uriIdentityService) {
            const result = await openSingletonWithTarget(
              {
                groups: groupsService,
                aux: auxService,
                inst: instantiation,
                uriIdentity: uriIdentityService,
              },
              target,
              preview.id,
              () => new MarkdownPreviewInput(uri),
              { pinned: true },
            )
            if (result.handled) {
              if (opts?.fragment) MarkdownPreviewRegistry.revealAnchor(uri, opts.fragment)
              return
            }
          }
          const group =
            target === 'side' ? ensureSideGroup(groupsService) : groupsService.openTargetGroup
          openPreviewInGroup(
            groupsService,
            group,
            preview,
            windowFocus ? { windowFocus } : undefined,
          )
          if (opts?.fragment) MarkdownPreviewRegistry.revealAnchor(uri, opts.fragment)
          return
        }
        // A new-window open routes through the shared helper so an already-open
        // file is copied/moved instead of duplicated. Ctrl/Cmd+click keeps the
        // original path: activate the side group first, then open through the
        // resolver/editor service, which both follow `activeGroupForOpen`.
        if (
          target === 'newWindow' &&
          groupsService &&
          instantiation &&
          auxService &&
          uriIdentityService
        ) {
          const targets = {
            groups: groupsService,
            aux: auxService,
            inst: instantiation,
            uriIdentity: uriIdentityService,
            ...(editorResolver ? { resolver: editorResolver } : {}),
          }
          if (line === undefined && editorResolver) {
            const result = await openUriWithTarget(targets, uri, 'newWindow', { pinned: true })
            if (result.handled) return
          } else {
            const input = instantiation.createInstance(FileEditorInput, uri)
            const result = await openFreshInputWithTarget(targets, input, 'newWindow', {
              pinned: true,
            })
            if (result.handled) {
              if (line !== undefined && result.editor instanceof FileEditorInput) {
                void revealSelectionInInput(result.editor, {
                  startLineNumber: line,
                  startColumn: col ?? 1,
                  ...(endLine !== undefined ? { endLineNumber: endLine } : {}),
                })
              }
              return
            }
          }
        }
        // Ctrl/Cmd+click: everything below opens an editor, so create/activate
        // the side group first — the resolver and the editor service both route
        // a new editor through `activeGroupForOpen`, which follows it.
        if (target === 'side' && groupsService) ensureSideGroup(groupsService)
        // A `:line` location targets the text source at that line, which only a
        // FileEditorInput can honor (the resolver carries no selection). Without
        // a line, route through the editor resolver so specialized editors win —
        // e.g. an image extension opens the image preview instead of showing the
        // binary as garbled text (mirrors the explorer / dropped-file path).
        if (line === undefined && editorResolver) {
          void editorResolver.openEditor(uri, { pinned: true })
          return
        }
        const input = instantiation.createInstance(FileEditorInput, uri)
        if (line !== undefined) {
          // openEditor dedupes to an already-open tab and disposes `input`, so
          // reveal against the instance it returns (it may live in another window).
          openEditorAndReveal(
            editorService,
            input,
            {
              startLineNumber: line,
              startColumn: col ?? 1,
              ...(endLine !== undefined ? { endLineNumber: endLine } : {}),
            },
            { pinned: true },
          )
        } else {
          editorService.openEditor(input, { pinned: true })
        }
      })
    },
    [
      resolve,
      fileService,
      editorService,
      editorResolver,
      groupsService,
      instantiation,
      auxService,
      uriIdentityService,
      notificationService,
      windowsService,
      workspaceService,
      lifecycleService,
      quickAccess,
      previewLinks,
      windowFocus,
    ],
  )
}

/** Stat a resolved URI to route a directory target to the window/folder opener. */
async function isDirectory(fileService: IFileService | undefined, uri: URI): Promise<boolean> {
  if (!fileService) return false
  try {
    return (await fileService.stat(uri)).isDirectory
  } catch {
    return false
  }
}

function cacheGet(map: Map<string, CacheEntry>, key: string, now: number): Resolution | undefined {
  const entry = map.get(key)
  if (entry && entry.expiresAt > now) return entry.resolution
  return undefined
}
