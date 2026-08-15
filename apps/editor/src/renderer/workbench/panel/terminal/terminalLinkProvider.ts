import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm'
import { expandHomeDir, type URI, normalizeFsPath } from '@universe-editor/platform'
import { FILE_PATH_PATTERN, parseFilePathLocation } from '../../../services/acp/filePathLink.js'

// Reuse the same path grammar as rendered markdown so terminal and markdown
// links recognize exactly the same set of files (extensions, location suffixes).
// The `u` flag is required — FILE_PATH_PATTERN embeds Unicode property classes
// (\p{L}\p{N}) so CJK file names are recognized.
const FILE_LINK_RE = new RegExp(FILE_PATH_PATTERN, 'gu')

export function resolvePath(cwd: string, filePath: string, home: string | undefined): string {
  const expanded = home ? (expandHomeDir(filePath, home) ?? filePath) : filePath
  if (/^[A-Za-z]:[/\\]/.test(expanded) || expanded.startsWith('/')) return normalizeFsPath(expanded)
  return normalizeFsPath(cwd + '/' + expanded)
}

export function createFileLinkProvider(
  term: Terminal,
  resolveFile: (absolutePath: string) => Promise<URI | null>,
  openFile: (uri: URI, line?: number, col?: number, endLine?: number) => void,
  getCwd: () => string,
  getHome: () => string | undefined,
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
      const home = getHome()

      type MatchInfo = {
        full: string
        absPath: string
        lineNum: number | undefined
        colNum: number | undefined
        endLineNum: number | undefined
        startX: number
        endX: number
      }

      const matches: MatchInfo[] = []
      FILE_LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_LINK_RE.exec(text)) !== null) {
        const full = m[0] ?? ''
        const filePath = m[1] ?? ''
        const { line: lineNum, col: colNum, endLine: endLineNum } = parseFilePathLocation(m)
        matches.push({
          full,
          absPath: resolvePath(cwd, filePath, home),
          lineNum,
          colNum,
          endLineNum,
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
              if (uri) openFile(uri, match.lineNum, match.colNum, match.endLineNum)
            })
          },
        }
      })
      callback(links)
    },
  }
}
