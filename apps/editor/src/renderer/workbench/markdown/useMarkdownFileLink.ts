/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMarkdownFileLink — resolve and open a file path clicked inside rendered
 *  markdown. Absolute paths open directly; relative paths resolve against the
 *  view's baseUri (the markdown source's directory, or the workspace root for
 *  agent chat). When the exact path is missing we fall back to a fuzzy workspace
 *  search; if nothing matches we surface a "file not found" notification.
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
  IEditorService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  INotificationService,
  IWorkspaceService,
  Severity,
  URI,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { openMarkdownPreviewInGroup } from '../../services/editor/openMarkdownPreview.js'
import { useOptionalService } from '../useService.js'

const CACHE_TTL = 10_000

type CacheEntry = Promise<URI | null> | { uri: URI | null; expiresAt: number }

/** Options carried from the click handler (which mouse modifiers were held). */
export interface OpenMarkdownLinkOptions {
  /** Ctrl/Cmd was held: open a new preview tab instead of navigating in place. */
  readonly toSide?: boolean
}

function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith('/')
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
  const groupsService = useOptionalService(IEditorGroupsService)
  const instantiation = useOptionalService(IInstantiationService)
  const notificationService = useOptionalService(INotificationService)
  const cache = useRef(new Map<string, CacheEntry>())

  const resolve = useCallback(
    (rawPath: string): Promise<URI | null> => {
      if (!fileService) return Promise.resolve(null)
      const now = Date.now()
      const cached = cache.current.get(rawPath)
      if (cached instanceof Promise) return cached
      if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.uri)

      const promise = (async (): Promise<URI | null> => {
        const target = isAbsolutePath(rawPath)
          ? URI.file(rawPath)
          : baseUri
            ? URI.joinPath(baseUri, rawPath)
            : null
        if (target && (await fileService.exists(target))) return target

        const workspace = workspaceService?.current
        if (!workspace || !fileSearchService) return null

        const pattern = rawPath.split(/[/\\]/).filter(Boolean).join('/')
        const result = await fileSearchService.search({
          root: workspace.folder,
          pattern,
          includeExactPathMatches: true,
          maxResults: 10,
        })
        const first = result.results[0]
        return first ? (URI.revive(first.resource) as URI) : null
      })()

      cache.current.set(rawPath, promise)
      void promise.then((uri) => {
        cache.current.set(rawPath, { uri, expiresAt: Date.now() + CACHE_TTL })
      })
      return promise
    },
    [fileService, fileSearchService, workspaceService, baseUri],
  )

  return useCallback(
    (rawPath: string, line?: number, col?: number, opts?: OpenMarkdownLinkOptions) => {
      if (!editorService || !instantiation) return
      void resolve(rawPath).then((uri) => {
        if (!uri) {
          notificationService?.notify({
            severity: Severity.Warning,
            message: `文件不存在: ${rawPath}`,
          })
          return
        }
        // A markdown→markdown link in the preview opens as another preview
        // (in place, or to a new tab on Ctrl/Cmd+click). A `:line` location
        // means the user wants the source at that line, so fall through.
        if (previewLinks && groupsService && line === undefined && isMarkdownResource(uri)) {
          openMarkdownPreviewInGroup(
            groupsService.activeGroup,
            new MarkdownPreviewInput(uri),
            opts?.toSide === true,
          )
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
    [resolve, editorService, groupsService, instantiation, notificationService, previewLinks],
  )
}
