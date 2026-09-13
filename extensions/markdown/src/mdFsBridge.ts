/**
 * Backs the markdown language service's filesystem reads. The service hands us
 * `file:` URI strings (for files the user hasn't opened — link targets, workspace
 * scans); the renderer's open documents never reach here — the service's
 * DocumentStore overlay answers those first.
 *
 * Reads that stay inside the workspace go through the host's gated `workspace.fs`
 * (the path policy vets them). A link may legitimately point at an *absolute path
 * outside the workspace* (e.g. `[vscode](D:/workspace/vscode)`); the gated fs
 * denies those, which would make a real file/dir read as "does not exist". Since
 * markdown is a trusted built-in plugin (same trust level as the git extension,
 * which also uses `node:fs`), we read those directly with `node:fs` — bypassing
 * the *agent-facing* gate without weakening it. Relative paths and anything under
 * the workspace still prefer `workspace.fs`.
 */
import { stat as nodeStat, readFile as nodeReadFile, readdir } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { workspace, FileType, type FileStat } from '@universe-editor/extension-api'
import { URI } from 'vscode-uri'
import type { IMdClient, MdFileStat, MdFileType } from './server/types.js'

/**
 * Upper bound for the workspace markdown scan. The scan feeds workspace symbols,
 * link validation and header completions — all "best effort over the workspace"
 * features — so a bound is the right trade: on a game depot the tree holds
 * millions of files and an unbounded scan is indistinguishable from a hang.
 */
const MAX_MARKDOWN_FILES = 5_000

const decoder = new TextDecoder('utf-8', { fatal: false })

/** `file:` URI string → filesystem path for the gated `workspace.fs`. A
 *  non-`file:` URI (a future remote scheme) has no host-local path. */
function fsPath(uri: string): string | undefined {
  const parsed = URI.parse(uri)
  return parsed.scheme === 'file' ? parsed.fsPath : undefined
}

export function createMdFsBridge(root: URI | undefined): IMdClient {
  // Host-local workspace root (always a `file:` URI built from `workspace.rootPath`).
  const rootPath = root?.fsPath

  /** True when `path` escapes the workspace root, so it needs the direct-fs path. */
  const isOutsideWorkspace = (path: string): boolean => {
    if (!rootPath || !isAbsolute(path)) return false
    const rel = relative(rootPath, path)
    return rel.startsWith('..') || isAbsolute(rel)
  }

  const readDir = async (uri: URI): Promise<[string, FileType][]> => {
    if (uri.scheme !== 'file') return []
    const path = uri.fsPath
    if (isOutsideWorkspace(path)) {
      try {
        const entries = await readdir(path, { withFileTypes: true })
        return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File])
      } catch {
        return []
      }
    }
    try {
      return await workspace.fs.readDirectory(path)
    } catch {
      return []
    }
  }

  return {
    $readFile: async (uri) => {
      const path = fsPath(uri)
      if (path === undefined) return undefined
      if (isOutsideWorkspace(path)) {
        try {
          return decoder.decode(await nodeReadFile(path))
        } catch {
          return undefined
        }
      }
      try {
        const bytes = await workspace.fs.readFile(path)
        return decoder.decode(bytes)
      } catch {
        return undefined
      }
    },
    $stat: async (uri) => {
      const path = fsPath(uri)
      if (path === undefined) return undefined
      if (isOutsideWorkspace(path)) {
        try {
          const s = await nodeStat(path)
          const type: MdFileType = s.isDirectory() ? 'dir' : 'file'
          return { type, mtime: s.mtimeMs, size: s.size } satisfies MdFileStat
        } catch {
          return undefined
        }
      }
      try {
        const s: FileStat = await workspace.fs.stat(path)
        const type: MdFileType = s.type === FileType.Directory ? 'dir' : 'file'
        return { type, mtime: s.mtime, size: s.size } satisfies MdFileStat
      } catch {
        return undefined
      }
    },
    $readDirectory: async (uri) => {
      const entries = await readDir(URI.parse(uri))
      return entries.map(
        ([name, type]) =>
          [name, type === FileType.Directory ? 'dir' : 'file'] as readonly [string, MdFileType],
      )
    },
    $findMarkdownFiles: async () => {
      if (!root) return []
      // Goes through the renderer's rg-backed enumeration: bounded and prunes the
      // configured search excludes during the walk. The previous hand-rolled
      // recursive walk issued one `workspace.fs.readDirectory` RPC per directory —
      // on a game depot (600k+ directories, millions of files) that never
      // returned, which pinned the '#' workspace-symbol picker's spinner forever
      // and swallowed every other provider's symbols along with it.
      const found = await workspace.findFiles('**/*.{md,markdown}', undefined, MAX_MARKDOWN_FILES)
      return found.map((uri) => uri.toString())
    },
  }
}
