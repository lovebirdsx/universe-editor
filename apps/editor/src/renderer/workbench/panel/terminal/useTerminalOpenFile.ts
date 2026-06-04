import { useCallback, useRef } from 'react'
import {
  IEditorService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  IWorkspaceService,
  URI,
  normalizeFsPath,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import { useService } from '../../useService.js'

const CACHE_TTL = 10_000

type CacheEntry = Promise<URI | null> | { uri: URI | null; expiresAt: number }

/**
 * Returns a resolver that pre-warms during provideLinks and caches results for 10s.
 * Multiple callers for the same path share one in-flight promise.
 */
export function useResolveTerminalFile(): (absolutePath: string) => Promise<URI | null> {
  const fileService = useService(IFileService)
  const fileSearchService = useService(IFileSearchService)
  const workspaceService = useService(IWorkspaceService)
  const cache = useRef(new Map<string, CacheEntry>())

  return useCallback(
    (absolutePath: string): Promise<URI | null> => {
      const now = Date.now()
      const cached = cache.current.get(absolutePath)
      if (cached instanceof Promise) return cached
      if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.uri)

      const promise = (async (): Promise<URI | null> => {
        const uri = URI.file(absolutePath)
        if (await fileService.exists(uri)) return uri

        const workspace = workspaceService.current
        if (!workspace) return null

        const norm = normalizeFsPath(absolutePath)
        const root = normalizeFsPath(workspace.folder.fsPath)
        const pattern = norm.startsWith(root + '/')
          ? norm.slice(root.length + 1)
          : (norm.split('/').pop() ?? norm)

        const result = await fileSearchService.search({
          root: workspace.folder,
          pattern,
          includeExactPathMatches: true,
          maxResults: 10,
        })

        const first = result.results[0]
        return first ? (URI.revive(first.resource) as URI) : null
      })()

      cache.current.set(absolutePath, promise)
      void promise.then((uri) => {
        cache.current.set(absolutePath, { uri, expiresAt: Date.now() + CACHE_TTL })
      })
      return promise
    },
    [fileService, fileSearchService, workspaceService],
  )
}

/**
 * Opens an already-resolved URI in the editor with optional cursor positioning.
 * This is intentionally synchronous-looking: no IPC happens here.
 */
export function useOpenTerminalFile(): (uri: URI, line?: number, col?: number) => void {
  const editorService = useService(IEditorService)
  const instantiation = useService(IInstantiationService)

  return useCallback(
    (uri: URI, line?: number, col?: number) => {
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
    },
    [editorService, instantiation],
  )
}
