/**
 * Backs the markdown language service's filesystem reads. The service hands us
 * `file:` URI strings (for files the user hasn't opened — link targets, workspace
 * scans); the renderer's open documents never reach here — the service's
 * DocumentStore overlay answers those first.
 *
 * Reads that stay inside the workspace go through the host's gated `workspace.fs`
 * (the path policy vets them). A link may legitimately point at an *absolute path
 * outside the workspace* (e.g. `[vscode](D:/git_project/vscode)`); the gated fs
 * denies those, which would make a real file/dir read as "does not exist". Since
 * markdown is a trusted built-in plugin (same trust level as the git extension,
 * which also uses `node:fs`), we read those directly with `node:fs` — bypassing
 * the *agent-facing* gate without weakening it. Relative paths and anything under
 * the workspace still prefer `workspace.fs`.
 */
import { stat as nodeStat, readFile as nodeReadFile, readdir } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { workspace, FileType, type FileStat } from '@universe-editor/extension-api'
import { URI, Utils } from 'vscode-uri'
import type { IMdClient, MdFileStat, MdFileType } from './server/types.js'

/** Directories never scanned for markdown (parity with the file-watcher excludes). */
const SCAN_IGNORE: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'out', '.turbo'])
const MARKDOWN_EXT = /\.(md|markdown)$/i

const decoder = new TextDecoder('utf-8', { fatal: false })

/** `file:` URI string → filesystem path for the gated `workspace.fs`. */
function fsPath(uri: string): string {
  return URI.parse(uri).fsPath
}

export function createMdFsBridge(root: URI | undefined): IMdClient {
  const rootPath = root?.fsPath

  /** True when `path` escapes the workspace root, so it needs the direct-fs path. */
  const isOutsideWorkspace = (path: string): boolean => {
    if (!rootPath || !isAbsolute(path)) return false
    const rel = relative(rootPath, path)
    return rel.startsWith('..') || isAbsolute(rel)
  }

  const readDir = async (uri: URI): Promise<[string, FileType][]> => {
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

  const collectMarkdown = async (dir: URI, out: string[]): Promise<void> => {
    for (const [name, type] of await readDir(dir)) {
      if (type === FileType.Directory) {
        if (SCAN_IGNORE.has(name)) continue
        await collectMarkdown(Utils.joinPath(dir, name), out)
      } else if (MARKDOWN_EXT.test(name)) {
        out.push(Utils.joinPath(dir, name).toString())
      }
    }
  }

  return {
    $readFile: async (uri) => {
      const path = fsPath(uri)
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
      const out: string[] = []
      await collectMarkdown(root, out)
      return out
    },
  }
}
