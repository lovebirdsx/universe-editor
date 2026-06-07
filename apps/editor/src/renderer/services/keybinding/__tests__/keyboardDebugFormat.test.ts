/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the pure keyboard-debug formatters.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { KeystrokeTrace } from '@universe-editor/platform'
import {
  formatGuardStop,
  formatHeader,
  formatKeystrokeTrace,
  type KeyEventDiagnostics,
} from '../keyboardDebugFormat.js'

function diag(overrides: Partial<KeyEventDiagnostics> = {}): KeyEventDiagnostics {
  return {
    time: '14:23:01.123',
    code: 'KeyS',
    key: 's',
    ctrl: true,
    alt: false,
    shift: false,
    meta: false,
    isComposing: false,
    builtKey: 'ctrl+s',
    targetTag: 'BODY',
    isEditable: false,
    ...overrides,
  }
}

describe('formatHeader', () => {
  it('includes the enabled banner and the not-covered list', () => {
    const header = formatHeader()
    expect(header).toContain('ENABLED')
    expect(header).toContain('Monaco')
    expect(header).toContain('IME')
  })
})

describe('formatGuardStop', () => {
  it('renders the event line and the stop reason', () => {
    const out = formatGuardStop(
      diag({ builtKey: 'a', key: 'a', ctrl: false }),
      'reserved for text input',
    )
    expect(out).toContain('[14:23:01.123] keydown')
    expect(out).toContain('built="a"')
    expect(out).toContain('⤫ not dispatched: reserved for text input')
  })

  it('appends an optional detail', () => {
    const out = formatGuardStop(diag(), 'guard', 'extra detail')
    expect(out).toContain('guard — extra detail')
  })
})

describe('formatKeystrokeTrace', () => {
  it('execute: shows the resolved command and a ✓ candidate', () => {
    const trace: KeystrokeTrace = {
      kind: 'execute',
      normalizedKey: 'ctrl+s',
      pending: undefined,
      command: 'save',
      candidates: [
        {
          chords: ['ctrl+s'],
          command: 'save',
          isNegated: false,
          when: undefined,
          whenKeys: [],
          whenMatched: true,
          outcomeReason: 'matched',
          selected: true,
        },
      ],
    }
    const out = formatKeystrokeTrace(diag(), trace)
    expect(out).toContain('EXECUTE save')
    expect(out).toContain('✓ save [ctrl+s]')
  })

  it('no-match with when-failed: shows the when-clause and key snapshot', () => {
    const trace: KeystrokeTrace = {
      kind: 'no-match',
      normalizedKey: 'ctrl+s',
      pending: undefined,
      candidates: [
        {
          chords: ['ctrl+s'],
          command: 'save',
          isNegated: false,
          when: 'editorFocus',
          whenKeys: [{ key: 'editorFocus', value: false }],
          whenMatched: false,
          outcomeReason: 'when-failed',
          selected: false,
        },
      ],
    }
    const out = formatKeystrokeTrace(diag(), trace)
    expect(out).toContain('NO MATCH')
    expect(out).toContain('✗ save [ctrl+s] when="editorFocus" → when-failed {editorFocus=false}')
  })

  it('no-match with no candidates: explains the key is unbound', () => {
    const trace: KeystrokeTrace = {
      kind: 'no-match',
      normalizedKey: 'ctrl+x',
      pending: undefined,
      candidates: [],
    }
    expect(formatKeystrokeTrace(diag({ builtKey: 'ctrl+x' }), trace)).toContain(
      'no binding registered',
    )
  })

  it('enter-chord: notes waiting for the second key', () => {
    const trace: KeystrokeTrace = {
      kind: 'enter-chord',
      normalizedKey: 'ctrl+k',
      pending: undefined,
      chordPending: ['ctrl+k'],
      candidates: [
        {
          chords: ['ctrl+k', 'ctrl+s'],
          command: 'openKb',
          isNegated: false,
          when: undefined,
          whenKeys: [],
          whenMatched: true,
          outcomeReason: 'matched',
          selected: true,
        },
      ],
    }
    const out = formatKeystrokeTrace(diag({ builtKey: 'ctrl+k' }), trace)
    expect(out).toContain('ENTER CHORD')
    expect(out).toContain('✓ openKb [ctrl+k ctrl+s]')
  })

  it('is-negated candidate renders its reason', () => {
    const trace: KeystrokeTrace = {
      kind: 'no-match',
      normalizedKey: 'ctrl+s',
      pending: undefined,
      candidates: [
        {
          chords: ['ctrl+s'],
          command: 'save',
          isNegated: true,
          when: undefined,
          whenKeys: [],
          whenMatched: true,
          outcomeReason: 'is-negated',
          selected: false,
        },
      ],
    }
    expect(formatKeystrokeTrace(diag(), trace)).toContain('→ is-negated')
  })
})
