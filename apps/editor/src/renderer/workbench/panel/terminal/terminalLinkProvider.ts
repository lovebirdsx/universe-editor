import type { Terminal, ILinkProvider, ILink } from '@xterm/xterm'
import { expandHomeDir, type URI, normalizeFsPath } from '@universe-editor/platform'
import { FILE_PATH_PATTERN, parseFilePathLocation } from '../../../services/acp/filePathLink.js'
import { mapStringIndexToCell, readWrappedWindow } from './terminalBufferText.js'
import { resolveOpenTarget, type OpenTarget } from '../../../services/editor/openTarget.js'

// Reuse the same path grammar as rendered markdown so terminal and markdown
// links recognize exactly the same set of files (extensions, location suffixes).
// The `u` flag is required — FILE_PATH_PATTERN embeds Unicode property classes
// (\p{L}\p{N}) so CJK file names are recognized.
const FILE_LINK_RE = new RegExp(FILE_PATH_PATTERN, 'gu')
// The path grammar also matches the tail of a URL (`https://aka.ms/pscore6` in the
// PowerShell banner); the token leading up to the match decides. Two+ letter
// schemes only, so `C:/x` drive paths stay links.
const URL_PREFIX_RE = /[A-Za-z][\w+.-]+:\/\S*$/

/**
 * `search: false` (hover) may only stat the exact path; the workspace-wide file
 * search fallback is reserved for a click — on a huge tree it is a full ripgrep
 * walk, and hovering terminal output must never start one.
 */
export type ResolveTerminalFile = (
  absolutePath: string,
  options?: { readonly search?: boolean },
) => Promise<URI | null>

export function resolvePath(cwd: string, filePath: string, home: string | undefined): string {
  const expanded = home ? (expandHomeDir(filePath, home) ?? filePath) : filePath
  if (/^[A-Za-z]:[/\\]/.test(expanded) || expanded.startsWith('/')) return normalizeFsPath(expanded)
  return normalizeFsPath(cwd + '/' + expanded)
}

export function createFileLinkProvider(
  term: Terminal,
  resolveFile: ResolveTerminalFile,
  openFile: (uri: URI, line?: number, col?: number, endLine?: number, target?: OpenTarget) => void,
  getCwd: () => string,
  getHome: () => string | undefined,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buf = term.buffer.active
      const win = readWrappedWindow(buf, bufferLineNumber - 1)

      const cwd = getCwd()
      const home = getHome()

      type MatchInfo = {
        full: string
        absPath: string
        lineNum: number | undefined
        colNum: number | undefined
        endLineNum: number | undefined
        start: { y: number; x: number }
        end: { y: number; x: number }
      }

      const matches: MatchInfo[] = []
      FILE_LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_LINK_RE.exec(win.text)) !== null) {
        const full = m[0] ?? ''
        const filePath = m[1] ?? ''
        const tokenStart = Math.max(
          win.text.lastIndexOf(' ', m.index - 1),
          win.text.lastIndexOf('\t', m.index - 1),
        )
        if (URL_PREFIX_RE.test(win.text.slice(tokenStart + 1, m.index))) continue
        const { line: lineNum, col: colNum, endLine: endLineNum } = parseFilePathLocation(m)
        const start = mapStringIndexToCell(buf, win.startLineIndex, 0, m.index)
        if (!start) continue
        // Walk on from `start` rather than re-walking the match prefix from the
        // window origin — same cell either way, one less pass.
        const end = mapStringIndexToCell(buf, start.y, start.x, full.length, 'exclusiveEnd')
        if (!end) continue
        matches.push({
          full,
          absPath: resolvePath(cwd, filePath, home),
          lineNum,
          colNum,
          endLineNum,
          start,
          end,
        })
      }

      // The wrapped window spans several rows, so it also yields matches lying
      // entirely on other rows. Those must not be answered with: xterm's
      // Linkifier._removeIntersectingLinks projects every returned link onto the
      // hovered row (start.y < y becomes column 0) and drops any link whose
      // projected span collides with an already-claimed column. An off-row link
      // would squat on the low columns and evict the genuinely wrapped link from
      // the reply — leaving the wrapped path unclickable.
      const onRow = matches.filter((match) => {
        // end.x === 0 means the link stopped exactly on the column boundary, so
        // its last visible row is the one above `end.y`.
        const lastRow = match.end.x === 0 ? Math.max(match.start.y, match.end.y - 1) : match.end.y
        const row = bufferLineNumber - 1
        return match.start.y <= row && row <= lastRow
      })
      if (onRow.length === 0) {
        callback(undefined)
        return
      }

      // Return links to xterm immediately so the pointer cursor appears without
      // delay. Hover only pre-stats the exact path (cheap); activate() awaits it
      // and falls back to the workspace search only on a click.
      const links: ILink[] = onRow.map((match) => {
        const statPromise = resolveFile(match.absPath)
        return {
          range: {
            start: { x: match.start.x + 1, y: match.start.y + 1 },
            end: { x: match.end.x, y: match.end.y + 1 },
          },
          text: match.full,
          activate(event: MouseEvent) {
            if (event.button !== 0) return
            const target = resolveOpenTarget(event)
            void statPromise
              .then((uri) => uri ?? resolveFile(match.absPath, { search: true }))
              .then((uri) => {
                if (uri) openFile(uri, match.lineNum, match.colNum, match.endLineNum, target)
              })
          },
        }
      })
      callback(links)
    },
  }
}
