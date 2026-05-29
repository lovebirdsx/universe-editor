/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ansi — parse a string carrying ANSI SGR escape sequences into styled text
 *  segments. Used to render `execute` tool-call output (command terminals emit
 *  colour codes) without leaking raw `\x1b[..m` noise into the UI.
 *
 *  Only SGR (colour / weight / style) is interpreted; every other escape
 *  sequence (cursor movement, screen clears, OSC title sets, …) is swallowed so
 *  the function doubles as a strip-ANSI fallback. Pure / DOM-free for easy unit
 *  testing.
 *--------------------------------------------------------------------------------------------*/

export interface AnsiSegment {
  readonly text: string
  readonly fg?: string
  readonly bg?: string
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
}

interface AnsiState {
  fg: string | undefined
  bg: string | undefined
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
}

const ESC = '\x1b'
const BEL = '\x07'

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const

function standardColor(index: number, bright: boolean): string {
  const name = NAMES[index] ?? 'white'
  return bright ? `var(--acp-ansi-bright-${name})` : `var(--acp-ansi-${name})`
}

/** Resolve an xterm 256-colour index to a concrete CSS colour. */
function color256(n: number): string {
  if (n < 8) return standardColor(n, false)
  if (n < 16) return standardColor(n - 8, true)
  if (n < 232) {
    const i = n - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i % 36) / 6)
    const b = i % 6
    const channel = (v: number) => (v === 0 ? 0 : v * 40 + 55)
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`
  }
  const v = (n - 232) * 10 + 8
  return `rgb(${v}, ${v}, ${v})`
}

function emptyState(): AnsiState {
  return { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false }
}

function reset(state: AnsiState): void {
  state.fg = undefined
  state.bg = undefined
  state.bold = false
  state.dim = false
  state.italic = false
  state.underline = false
}

/** Apply one SGR sequence's numeric parameters to the running style state. */
function applySgr(state: AnsiState, params: readonly number[]): void {
  for (let i = 0; i < params.length; i++) {
    const code = params[i] ?? 0
    if (code === 0) {
      reset(state)
    } else if (code === 1) {
      state.bold = true
    } else if (code === 2) {
      state.dim = true
    } else if (code === 3) {
      state.italic = true
    } else if (code === 4) {
      state.underline = true
    } else if (code === 22) {
      state.bold = false
      state.dim = false
    } else if (code === 23) {
      state.italic = false
    } else if (code === 24) {
      state.underline = false
    } else if (code >= 30 && code <= 37) {
      state.fg = standardColor(code - 30, false)
    } else if (code >= 90 && code <= 97) {
      state.fg = standardColor(code - 90, true)
    } else if (code >= 40 && code <= 47) {
      state.bg = standardColor(code - 40, false)
    } else if (code >= 100 && code <= 107) {
      state.bg = standardColor(code - 100, true)
    } else if (code === 39) {
      state.fg = undefined
    } else if (code === 49) {
      state.bg = undefined
    } else if (code === 38 || code === 48) {
      const isFg = code === 38
      const mode = params[i + 1]
      if (mode === 5) {
        const n = params[i + 2]
        if (n != null) {
          const c = color256(n)
          if (isFg) state.fg = c
          else state.bg = c
        }
        i += 2
      } else if (mode === 2) {
        const r = params[i + 2]
        const g = params[i + 3]
        const b = params[i + 4]
        if (r != null && g != null && b != null) {
          const c = `rgb(${r}, ${g}, ${b})`
          if (isFg) state.fg = c
          else state.bg = c
        }
        i += 4
      }
    }
  }
}

function snapshot(text: string, state: AnsiState): AnsiSegment {
  return {
    text,
    ...(state.fg !== undefined ? { fg: state.fg } : {}),
    ...(state.bg !== undefined ? { bg: state.bg } : {}),
    ...(state.bold ? { bold: true } : {}),
    ...(state.dim ? { dim: true } : {}),
    ...(state.italic ? { italic: true } : {}),
    ...(state.underline ? { underline: true } : {}),
  }
}

/**
 * Parse `input` into styled segments. Plain text round-trips into a single
 * segment with no style fields. SGR escapes split the text into runs; all other
 * escape sequences are dropped.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const state = emptyState()
  let buffer = ''

  const flush = () => {
    if (buffer.length > 0) {
      segments.push(snapshot(buffer, state))
      buffer = ''
    }
  }

  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch !== ESC) {
      buffer += ch
      i++
      continue
    }

    const next = input[i + 1]
    if (next === '[') {
      // CSI sequence: ESC [ params... finalByte
      let j = i + 2
      while (j < input.length) {
        const c = input[j] ?? ''
        if (c >= '@' && c <= '~') break
        j++
      }
      const final = input[j]
      if (final === 'm') {
        flush()
        const body = input.slice(i + 2, j)
        const params =
          body.length === 0
            ? [0]
            : body.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)))
        applySgr(
          state,
          params.map((p) => (Number.isNaN(p) ? 0 : p)),
        )
      }
      // Non-SGR CSI (cursor moves, clears, …) is swallowed.
      i = final === undefined ? input.length : j + 1
    } else if (next === ']') {
      // OSC sequence: ESC ] ... terminated by BEL or ST (ESC \)
      let j = i + 2
      while (j < input.length) {
        if (input[j] === BEL) {
          j++
          break
        }
        if (input[j] === ESC && input[j + 1] === '\\') {
          j += 2
          break
        }
        j++
      }
      i = j
    } else if (next === undefined) {
      // Dangling ESC at end of input — drop it.
      i = input.length
    } else {
      // Two-byte escape (e.g. ESC c). Swallow both bytes.
      i += 2
    }
  }

  flush()
  return segments
}
