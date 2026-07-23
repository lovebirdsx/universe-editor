/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  conflictParser — scans text for git merge-conflict markers and returns the
 *  conflict regions. Mirrors VSCode's merge-conflict extension: a region runs
 *  from `<<<<<<<` (current / ours) through an optional `|||||||` (diff3 base)
 *  and `=======` to `>>>>>>>` (incoming / theirs). Line numbers are 1-based and
 *  inclusive, matching Monaco's coordinate system.
 *--------------------------------------------------------------------------------------------*/

const CURRENT_MARKER = '<<<<<<<'
/** The conflict-opening marker, exported for cheap "any conflict at all?"
 *  prefilters (e.g. a Monaco findNextMatch before a full-text parse). */
export const CONFLICT_START_MARKER = CURRENT_MARKER
const BASE_MARKER = '|||||||'
const SPLITTER_MARKER = '======='
const INCOMING_MARKER = '>>>>>>>'

export interface ConflictSide {
  /** Label after the marker (e.g. `HEAD`, a branch name), or '' when absent. */
  readonly name: string
  /** 1-based line of this side's marker (`<<<<<<<` / `|||||||` / `>>>>>>>`). */
  readonly headerLine: number
  /** 1-based first content line. When the side is empty, exceeds contentEndLine. */
  readonly contentStartLine: number
  /** 1-based last content line. When the side is empty, is below contentStartLine. */
  readonly contentEndLine: number
  /** The side's text, lines joined with `\n` (markers excluded). */
  readonly content: string
}

export interface ConflictRegion {
  /** 1-based line of the `<<<<<<<` marker. */
  readonly startLine: number
  /** 1-based line of the `>>>>>>>` marker. */
  readonly endLine: number
  /** The current / ours side (between `<<<<<<<` and `=======` / `|||||||`). */
  readonly current: ConflictSide
  /** The incoming / theirs side (between `=======` and `>>>>>>>`). */
  readonly incoming: ConflictSide
  /** The diff3 base side (between `|||||||` and `=======`), when present. */
  readonly base?: ConflictSide
}

const enum Scan {
  Text,
  Current,
  Base,
  Incoming,
}

interface PartialSide {
  name: string
  headerLine: number
  lines: string[]
  firstContentLine: number
}

function startSide(headerLine: number, marker: string, line: string): PartialSide {
  return {
    name: line.slice(marker.length).trim(),
    headerLine,
    lines: [],
    firstContentLine: headerLine + 1,
  }
}

function finishSide(side: PartialSide, nextMarkerLine: number): ConflictSide {
  const contentEndLine = nextMarkerLine - 1
  return {
    name: side.name,
    headerLine: side.headerLine,
    contentStartLine: side.firstContentLine,
    contentEndLine,
    content: side.lines.join('\n'),
  }
}

export function parseConflicts(text: string): ConflictRegion[] {
  const lines = text.split(/\r?\n/)
  const regions: ConflictRegion[] = []

  let scan: Scan = Scan.Text
  let current: PartialSide | undefined
  let base: PartialSide | undefined
  let incoming: PartialSide | undefined

  const reset = (): void => {
    scan = Scan.Text
    current = undefined
    base = undefined
    incoming = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNumber = i + 1

    // A fresh `<<<<<<<` while already inside a conflict means the previous one is
    // malformed (no closing marker). Drop it and start over from here.
    if (line.startsWith(CURRENT_MARKER) && scan !== Scan.Text) {
      reset()
    }

    switch (scan) {
      case Scan.Text:
        if (line.startsWith(CURRENT_MARKER)) {
          current = startSide(lineNumber, CURRENT_MARKER, line)
          scan = Scan.Current
        }
        break

      case Scan.Current:
        if (line.startsWith(BASE_MARKER)) {
          base = startSide(lineNumber, BASE_MARKER, line)
          scan = Scan.Base
        } else if (line.startsWith(SPLITTER_MARKER)) {
          incoming = startSide(lineNumber, SPLITTER_MARKER, line)
          scan = Scan.Incoming
        } else {
          current?.lines.push(line)
        }
        break

      case Scan.Base:
        if (line.startsWith(SPLITTER_MARKER)) {
          incoming = startSide(lineNumber, SPLITTER_MARKER, line)
          scan = Scan.Incoming
        } else {
          base?.lines.push(line)
        }
        break

      case Scan.Incoming:
        if (line.startsWith(INCOMING_MARKER)) {
          if (current && incoming) {
            const splitterLine = incoming.headerLine
            const currentSide = finishSide(current, base ? base.headerLine : splitterLine)
            const incomingSide = finishSide(incoming, lineNumber)
            const region: ConflictRegion = {
              startLine: current.headerLine,
              endLine: lineNumber,
              current: currentSide,
              incoming: { ...incomingSide, name: line.slice(INCOMING_MARKER.length).trim() },
              ...(base ? { base: finishSide(base, splitterLine) } : {}),
            }
            regions.push(region)
          }
          reset()
        } else {
          incoming?.lines.push(line)
        }
        break
    }
  }

  return regions
}
