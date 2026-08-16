import { useCallback, useMemo, useRef } from 'react'
import {
  IFileSearchService,
  IFileService,
  ILoggerService,
  IOpenerService,
  IWorkspaceService,
  URI,
  absolutePathToWorkspaceUri,
  normalizeFsPath,
  withSelection,
} from '@universe-editor/platform'
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
  const loggerService = useService(ILoggerService)
  const logger = useMemo(
    () => loggerService.createLogger({ id: 'terminal-link', name: 'Terminal Link' }),
    [loggerService],
  )
  const cache = useRef(new Map<string, CacheEntry>())

  return useCallback(
    (absolutePath: string): Promise<URI | null> => {
      const now = Date.now()
      const cached = cache.current.get(absolutePath)
      if (cached instanceof Promise) return cached
      if (cached !== undefined && cached.expiresAt > now) return Promise.resolve(cached.uri)

      const promise = (async (): Promise<URI | null> => {
        try {
          const workspace = workspaceService.current
          // remote 工作区的 pty 在远端 spawn，终端输出的是远端路径，须继承 folder 的
          // scheme/authority 才能被 IFileService 按 scheme 分派到远端。
          const uri = absolutePathToWorkspaceUri(absolutePath, workspace?.folder)
          if (await fileService.exists(uri)) return uri

          if (!workspace) {
            logger.warn(`cannot resolve terminal link: ${absolutePath}`)
            return null
          }

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
          if (first) return URI.revive(first.resource) as URI
          logger.warn(`cannot resolve terminal link: ${absolutePath}`)
          return null
        } catch {
          // Never reject: the link provider's activate() awaits this promise
          // without a catch, so a rejection would silently swallow the click.
          logger.warn(`cannot resolve terminal link: ${absolutePath}`)
          return null
        }
      })()

      cache.current.set(absolutePath, promise)
      void promise.then((uri) => {
        cache.current.set(absolutePath, { uri, expiresAt: Date.now() + CACHE_TTL })
      })
      return promise
    },
    [fileService, fileSearchService, workspaceService, logger],
  )
}

/**
 * Opens an already-resolved URI via IOpenerService. A `:line` location is
 * encoded into the URI fragment with `withSelection` so the file opener reveals
 * the position; without a location the target flows through the same routing as
 * markdown/deep links (directory → new window, image → preview, etc.).
 */
export function useOpenTerminalFile(): (
  uri: URI,
  line?: number,
  col?: number,
  endLine?: number,
) => void {
  const opener = useService(IOpenerService)

  return useCallback(
    (uri: URI, line?: number, col?: number, endLine?: number) => {
      const target =
        line !== undefined
          ? withSelection(uri, {
              startLineNumber: line,
              startColumn: col ?? 1,
              ...(endLine !== undefined ? { endLineNumber: endLine } : {}),
            })
          : uri
      void opener.open(target, { fromUserGesture: true })
    },
    [opener],
  )
}
