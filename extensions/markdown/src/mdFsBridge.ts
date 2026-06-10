/**
 * Backs the markdown language service's filesystem reads. The service hands us
 * `file:` URI strings (for files the user hasn't opened — link targets, workspace
 * scans); we route them through the host's gated `workspace.fs`, which enforces
 * the path policy before touching disk. The renderer's open documents never reach
 * here — the service's DocumentStore overlay answers those first.
 */
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
  const readDir = async (uri: URI): Promise<[string, FileType][]> => {
    try {
      return await workspace.fs.readDirectory(uri.fsPath)
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
      try {
        const bytes = await workspace.fs.readFile(fsPath(uri))
        return decoder.decode(bytes)
      } catch {
        return undefined
      }
    },
    $stat: async (uri) => {
      try {
        const s: FileStat = await workspace.fs.stat(fsPath(uri))
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
