import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm'
import { type URI, normalizeFsPath } from '@universe-editor/platform'
import { FILE_PATH_PATTERN } from '../../../services/acp/filePathLink.js'

// Reuse the same path grammar as rendered markdown so terminal and markdown
// links recognize exactly the same set of files (extensions, location suffixes).
// The `u` flag is required — FILE_PATH_PATTERN embeds Unicode property classes
// (\p{L}\p{N}) so CJK file names are recognized.
const FILE_LINK_RE = new RegExp(FILE_PATH_PATTERN, 'gu')

function resolvePath(cwd: string, filePath: string): string {
  if (/^[A-Za-z]:[/\\]/.test(filePath) || filePath.startsWith('/')) return normalizeFsPath(filePath)
  return normalizeFsPath(cwd + '/' + filePath)
}

export function createFileLinkProvider(
  term: Terminal,
  resolveFile: (absolutePath: string) => Promise<URI | null>,
  openFile: (uri: URI, line?: number, col?: number) => void,
  getCwd: () => string,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const bufLine = term.buffer.active.getLine(bufferLineNumber - 1)
      if (!bufLine) {
        callback(undefined)
        return
      }

      const text = bufLine.translateToString(true)
      const cwd = getCwd()

      type MatchInfo = {
        full: string
        absPath: string
        lineNum: number | undefined
        colNum: number | undefined
        startX: number
        endX: number
      }

      const matches: MatchInfo[] = []
      FILE_LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_LINK_RE.exec(text)) !== null) {
        const full = m[0] ?? ''
        const filePath = m[1] ?? ''
        const lineNum = parseInt(m[2] ?? m[4] ?? '', 10) || undefined
        const colNum = parseInt(m[3] ?? m[5] ?? '', 10) || undefined
        matches.push({
          full,
          absPath: resolvePath(cwd, filePath),
          lineNum,
          colNum,
          startX: m.index + 1,
          endX: m.index + full.length,
        })
      }

      if (matches.length === 0) {
        callback(undefined)
        return
      }

      // Return links to xterm immediately so the pointer cursor appears without
      // delay. Each activate() awaits the already-in-flight resolve promise —
      // by click time it is almost always settled (cache hit or IPC done).
      const links: ILink[] = matches.map((match) => {
        const resolvePromise = resolveFile(match.absPath)
        return {
          range: {
            start: { x: match.startX, y: bufferLineNumber },
            end: { x: match.endX, y: bufferLineNumber },
          },
          text: match.full,
          activate(event: MouseEvent) {
            if (event.button !== 0) return
            void resolvePromise.then((uri) => {
              if (uri) openFile(uri, match.lineNum, match.colNum)
            })
          },
        }
      })
      callback(links)
    },
  }
}
