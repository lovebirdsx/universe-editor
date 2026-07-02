/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownFileLink — resolve and open a file path clicked inside rendered
 *  markdown. Concrete candidates (absolute, relative to the markdown source dir,
 *  relative to the workspace root) are probed first and opened on the first hit —
 *  no search, so an existing path opens instantly. Only when none exist do we
 *  fall back to a workspace file search: a single hit opens directly, several
 *  hits hand off to Go to File (prefilled with the path) so the user picks the
 *  intended target, and zero hits surfaces a "file not found" notification.
 *
 *  In `previewLinks` mode (the doc preview) a link to another markdown file opens
 *  as a *preview* rather than its source: a plain click navigates in place
 *  (replacing the current preview tab so Alt+←/→ walks the trail, VSCode-style),
 *  Ctrl/Cmd+click opens an additional preview tab in the same group. Links that
 *  carry a `:line` location, or point at non-markdown files, always open the
 *  source editor as before.
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
  IWindowsService,
  IWorkspaceService,
  Severity,
  ShutdownReason,
  URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewRegistry } from '../../services/editor/MarkdownPreviewRegistry.js'
import { openMarkdownPreviewInGroup } from '../../services/editor/openMarkdownPreview.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { IQuickAccessController } from '../../services/quickInput/QuickAccessController.js'
import { stripFilePathLinkPrefix } from '../../services/acp/filePathLink.js'
import { useOptionalService } from '../useService.js'
import { markdownLinkCandidates, searchPatternFor } from './markdownLinkResolve.js'

const CACHE_TTL = 10_000
const SEARCH_MAX_RESULTS = 10

/** Outcome of resolving a clicked path: open it, let the user pick, or report it missing. */
type Resolution =
  | { readonly kind: 'open'; readonly uri: URI }
  | { readonly kind: 'pick'; readonly pattern: string }
  | { readonly kind: 'missing' }

type CacheEntry = { readonly resolution: Resolution; readonly expiresAt: number }

/** Options carried from the click handler (which mouse modifiers were held). */
export interface OpenMarkdownLinkOptions {
  /** Ctrl/Cmd was held: open a new preview tab instead of navigating in place. */
  readonly toSide?: boolean
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

/**
 * Returns `openFileLink(rawPath, line?, col?, opts?)` for markdown links. The
 * path may be absolute or relative to {@link baseUri}; resolution is cached for
 * 10s and shares one in-flight promise across concurrent clicks on the same
 * path. When {@link previewLinks} is set (the doc preview), a markdown target
 * without a `:line` location opens as a preview instead of its source.
 */
export function useMarkdownFileLink(
  baseUri: URI | undefined,
  previewLinks = false,
): (rawPath: string, line?: number, col?: number, opts?: OpenMarkdownLinkOptions) => void {
  const fileService = useOptionalService(IFileService)
  const fileSearchService = useOptionalService(IFileSearchService)
  const workspaceService = useOptionalService(IWorkspaceService)
  const editorService = useOptionalService(IEditorService)
  const editorResolver = useOptionalService(IEditorResolverService)
  const groupsService = useOptionalService(IEditorGroupsService)
  const instantiation = useOptionalService(IInstantiationService)
  const notificationService = useOptionalService(INotificationService)
  const windowsService = useOptionalService(IWindowsService)
  const lifecycleService = useOptionalService(ILifecycleService)
  const excludeService = useOptionalService(IExcludeService)
  const quickAccess = useOptionalService(IQuickAccessController)
  const cache = useRef(new Map<string, CacheEntry>())
  const inflight = useRef(new Map<string, Promise<Resolution>>())

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
        // 1. Concrete candidates — open the first that exists, no search needed.
        for (const candidate of markdownLinkCandidates(normalizedRawPath, baseUri, workspaceRoot)) {
          if (await fileService.exists(candidate)) return { kind: 'open', uri: candidate }
        }

        // 2. Fuzzy fallback over the workspace, honoring the same excludes as Go
        //    to File so we never walk node_modules/dist/.git (the old slow path).
        if (!workspaceRoot || !fileSearchService) return { kind: 'missing' }
        const pattern = searchPatternFor(normalizedRawPath)
        if (pattern.length === 0) return { kind: 'missing' }
        const result = await fileSearchService.search({
          root: workspaceRoot,
          pattern,
          includeExactPathMatches: true,
          maxResults: SEARCH_MAX_RESULTS,
          ...(excludeService
            ? {
                excludes: excludeService.getSearchExcludeGlobs(),
                ignore: excludeService.getDirNameIgnores(),
              }
            : {}),
        })
        const hits = result.results
        if (hits.length === 0) return { kind: 'missing' }
        if (hits.length === 1) return { kind: 'open', uri: URI.revive(hits[0]!.resource) as URI }
        // Several matches: let the user disambiguate in Go to File, prefilled.
        return { kind: 'pick', pattern }
      })()

      inflight.current.set(normalizedRawPath, promise)
      void promise.then((resolution) => {
        inflight.current.delete(normalizedRawPath)
        // Only cache stable outcomes; a transient 'missing' (services not ready)
        // shouldn't be pinned for 10s.
        if (resolution.kind !== 'missing') {
          cache.current.set(normalizedRawPath, { resolution, expiresAt: Date.now() + CACHE_TTL })
        }
      })
      return promise
    },
    [fileService, fileSearchService, workspaceService, excludeService, baseUri],
  )

  return useCallback(
    (rawPath: string, line?: number, col?: number, opts?: OpenMarkdownLinkOptions) => {
      if (!editorService || !instantiation) return
      void resolve(rawPath).then(async (resolution) => {
        if (resolution.kind === 'missing') {
          notificationService?.notify({
            severity: Severity.Warning,
            message: `文件不存在: ${stripFilePathLinkPrefix(rawPath)}`,
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
        // A markdown→markdown link in the preview opens as another preview
        // (in place, or to a new tab on Ctrl/Cmd+click). A `:line` location
        // means the user wants the source at that line, so fall through.
        if (previewLinks && groupsService && line === undefined && isMarkdownResource(uri)) {
          const preview = new MarkdownPreviewInput(uri)
          openMarkdownPreviewInGroup(groupsService.activeGroup, preview, opts?.toSide === true)
          if (opts?.fragment) MarkdownPreviewRegistry.revealAnchor(uri, opts.fragment)
          return
        }
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
        editorService.openEditor(input, { pinned: true })
        if (line !== undefined) {
          setTimeout(() => {
            const editor = FileEditorRegistry.get(input)
            if (editor) {
              editor.setPosition({ lineNumber: line, column: col ?? 1 })
              editor.revealLineInCenter(line)
              editor.focus()
            }
          }, 50)
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
      notificationService,
      windowsService,
      workspaceService,
      lifecycleService,
      quickAccess,
      previewLinks,
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
