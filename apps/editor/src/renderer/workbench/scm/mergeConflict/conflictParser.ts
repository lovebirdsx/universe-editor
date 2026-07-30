/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  conflictParser — scans text for SCM merge-conflict markers and returns the
 *  conflict regions. Two marker formats are recognized in a single state
 *  machine, chosen so they can never interleave:
 *
 *  - git (VSCode merge-conflict extension parity): a region runs from
 *    `<<<<<<<` (current / ours) through an optional `|||||||` (diff3 base) and
 *    `=======` to `>>>>>>>` (incoming / theirs).
 *  - Perforce (`p4 resolve` with conflict markers): a region runs from
 *    `>>>> ORIGINAL VERSION` (base) through `==== THEIRS` (incoming / depot)
 *    and `==== YOURS` (current / workspace) to `<<<<`. The `==== YOURS` marker
 *    may be omitted, leaving an empty current side.
 *
 *  The start markers are never a prefix of one another and every in-block
 *  transition only accepts the current format's markers, so the two formats
 *  cannot mix inside one block. A block only becomes a region when its full
 *  strict marker sequence completed — a lone `==== ` separator line or an
 *  unterminated block never yields one.
 *
 *  The emitted ConflictRegion shape is format-neutral: p4's YOURS maps to
 *  `current` and THEIRS to `incoming`, so the inline controller and the Merge
 *  Editor result pane need no per-provider branching. Line numbers are 1-based
 *  and inclusive, matching Monaco's coordinate system.
 *--------------------------------------------------------------------------------------------*/

const CURRENT_MARKER = '<<<<<<<'
const BASE_MARKER = '|||||||'
const SPLITTER_MARKER = '======='
const INCOMING_MARKER = '>>>>>>>'

const P4_BASE_MARKER = '>>>> '
const P4_SPLITTER_MARKER = '==== '
const P4_END_MARKER = '<<<<'

/** The conflict-opening markers, exported for cheap "any conflict at all?"
 *  prefilters (e.g. a Monaco findNextMatch before a full-text parse). */
export const CONFLICT_START_MARKERS: readonly string[] = [CURRENT_MARKER, P4_BASE_MARKER]

export interface ConflictSide {
  /** Label after the marker (e.g. `HEAD`, a branch name), or '' when absent. */
  readonly name: string
  /** 1-based line of this side's opening marker. */
  readonly headerLine: number
  /** 1-based first content line. When the side is empty, exceeds contentEndLine. */
  readonly contentStartLine: number
  /** 1-based last content line. When the side is empty, is below contentStartLine. */
  readonly contentEndLine: number
  /** The side's text, lines joined with `\n` (markers excluded). */
  readonly content: string
}

export interface ConflictRegion {
  /** 1-based line of the opening marker. */
  readonly startLine: number
  /** 1-based line of the closing marker. */
  readonly endLine: number
  /** The current / ours side (git: between `<<<<<<<` and `=======` / `|||||||`;
   *  p4: between `==== YOURS` and `<<<<`). */
  readonly current: ConflictSide
  /** The incoming / theirs side (git: between `=======` and `>>>>>>>`;
   *  p4: between `==== THEIRS` and `==== YOURS` / `<<<<`). */
  readonly incoming: ConflictSide
  /** The base side, when present (git diff3: between `|||||||` and `=======`;
   *  p4: between `>>>> ORIGINAL VERSION` and `==== THEIRS`). */
  readonly base?: ConflictSide
}

const enum Scan {
  Text,
  Current,
  Base,
  Incoming,
  P4Base,
  P4Theirs,
  P4Yours,
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

  /** Completes a p4 block. `yours` is undefined when the `==== YOURS` marker
   *  was omitted — the current side is then empty. */
  const finishP4Region = (
    p4Base: PartialSide,
    theirs: PartialSide,
    yours: PartialSide | undefined,
    endLineNumber: number,
  ): void => {
    const currentSide: ConflictSide = yours
      ? finishSide(yours, endLineNumber)
      : {
          name: '',
          headerLine: endLineNumber,
          contentStartLine: endLineNumber,
          contentEndLine: endLineNumber - 1,
          content: '',
        }
    regions.push({
      startLine: p4Base.headerLine,
      endLine: endLineNumber,
      current: currentSide,
      incoming: finishSide(theirs, yours ? yours.headerLine : endLineNumber),
      base: finishSide(p4Base, theirs.headerLine),
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNumber = i + 1

    // A fresh opening marker while already inside a conflict means the previous
    // one is malformed (no closing marker). Drop it and start over from here.
    if (
      (line.startsWith(CURRENT_MARKER) || line.startsWith(P4_BASE_MARKER)) &&
      scan !== Scan.Text
    ) {
      reset()
    }

    switch (scan) {
      case Scan.Text:
        if (line.startsWith(CURRENT_MARKER)) {
          current = startSide(lineNumber, CURRENT_MARKER, line)
          scan = Scan.Current
        } else if (line.startsWith(P4_BASE_MARKER)) {
          base = startSide(lineNumber, P4_BASE_MARKER, line)
          scan = Scan.P4Base
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

      case Scan.P4Base:
        if (line.startsWith(P4_SPLITTER_MARKER)) {
          incoming = startSide(lineNumber, P4_SPLITTER_MARKER, line)
          scan = Scan.P4Theirs
        } else {
          base?.lines.push(line)
        }
        break

      case Scan.P4Theirs:
        if (line.startsWith(P4_SPLITTER_MARKER)) {
          current = startSide(lineNumber, P4_SPLITTER_MARKER, line)
          scan = Scan.P4Yours
        } else if (line.startsWith(P4_END_MARKER)) {
          if (base && incoming) finishP4Region(base, incoming, undefined, lineNumber)
          reset()
        } else {
          incoming?.lines.push(line)
        }
        break

      case Scan.P4Yours:
        if (line.startsWith(P4_END_MARKER)) {
          if (base && incoming && current) finishP4Region(base, incoming, current, lineNumber)
          reset()
        } else {
          current?.lines.push(line)
        }
        break
    }
  }

  return regions
}
