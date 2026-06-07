/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure formatting for keyboard-shortcut troubleshooting output. No DOM access:
 *  callers flatten the KeyboardEvent into KeyEventDiagnostics first, so these
 *  functions are deterministic and snapshot-testable.
 *--------------------------------------------------------------------------------------------*/

import type {
  IKeybindingTraceCandidate,
  IKeybindingWhenKeyState,
  KeystrokeTrace,
} from '@universe-editor/platform'

/** A KeyboardEvent flattened to a plain, DOM-free object. */
export interface KeyEventDiagnostics {
  /** Pre-formatted clock time, e.g. "14:23:01.123". */
  readonly time: string
  readonly code: string
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly isComposing: boolean
  readonly builtKey: string
  readonly targetTag: string
  readonly isEditable: boolean
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return '<unset>'
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function formatWhenKeys(keys: readonly IKeybindingWhenKeyState[]): string {
  if (keys.length === 0) return ''
  return ` {${keys.map((k) => `${k.key}=${formatValue(k.value)}`).join(', ')}}`
}

function formatEventLine(diag: KeyEventDiagnostics): string {
  const mods = [diag.ctrl && 'ctrl', diag.alt && 'alt', diag.shift && 'shift', diag.meta && 'meta']
    .filter(Boolean)
    .join('+')
  const parts = [
    `code=${diag.code}`,
    `key=${JSON.stringify(diag.key)}`,
    `mods=${mods || '<none>'}`,
    `built=${JSON.stringify(diag.builtKey)}`,
    `target=${diag.targetTag}`,
    diag.isEditable ? 'editable=true' : 'editable=false',
  ]
  if (diag.isComposing) parts.push('composing=true')
  return `[${diag.time}] keydown ${parts.join(' ')}`
}

function formatCandidate(c: IKeybindingTraceCandidate): string {
  const marker = c.selected ? '✓' : '✗'
  const keys = c.chords.join(' ')
  const when = c.when !== undefined ? ` when=${JSON.stringify(c.when)}` : ''
  const reason = c.selected ? '' : ` → ${c.outcomeReason}${formatWhenKeys(c.whenKeys)}`
  return `      ${marker} ${c.command} [${keys}]${when}${reason}`
}

function formatCandidates(candidates: readonly IKeybindingTraceCandidate[]): string[] {
  if (candidates.length === 0) {
    return ['      (no binding registered for this key)']
  }
  return candidates.map(formatCandidate)
}

/**
 * One-time banner explaining the tool and its blind spots — the "no response"
 * causes this troubleshooter cannot see.
 */
export function formatHeader(): string {
  return [
    '================================================================',
    ' Keyboard Shortcuts Troubleshooting — ENABLED',
    ' Every keystroke below shows how it was dispatched and why.',
    '',
    ' Not covered by this tool:',
    '  • Keys consumed by Monaco editor (its own keybindings / IME / beforeinput)',
    '  • IME composition (look for composing=true)',
    '  • Keys intercepted by the OS or browser before reaching the app',
    '  • Commands invoked directly (command palette, e2e probe) — no keydown',
    ' If a key reaches "EXECUTE" here but nothing happens, inspect the',
    " command's own run() or a competing Monaco binding.",
    '================================================================',
  ].join('\n')
}

/** A keystroke stopped at a guard before reaching keybinding resolution. */
export function formatGuardStop(diag: KeyEventDiagnostics, guard: string, detail?: string): string {
  const reason = detail !== undefined ? `${guard} — ${detail}` : guard
  return `${formatEventLine(diag)}\n  ⤫ not dispatched: ${reason}`
}

/** A keystroke that reached keybinding resolution, with full candidate trace. */
export function formatKeystrokeTrace(diag: KeyEventDiagnostics, trace: KeystrokeTrace): string {
  const lines = [formatEventLine(diag)]
  const inChord = trace.pending !== undefined ? ` (chord: ${trace.pending.join(' ')} →)` : ''
  switch (trace.kind) {
    case 'execute':
      lines.push(
        `  → resolve ${JSON.stringify(trace.normalizedKey)}${inChord}: EXECUTE ${trace.command}`,
      )
      break
    case 'enter-chord':
      lines.push(
        `  → resolve ${JSON.stringify(trace.normalizedKey)}: ENTER CHORD (waiting for second key)`,
      )
      break
    case 'no-match':
      lines.push(`  → resolve ${JSON.stringify(trace.normalizedKey)}${inChord}: NO MATCH`)
      break
  }
  lines.push(...formatCandidates(trace.candidates))
  return lines.join('\n')
}
