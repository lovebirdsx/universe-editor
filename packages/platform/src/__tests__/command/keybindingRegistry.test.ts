/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for KeybindingsRegistry.traceKeystroke — the structured diagnostics
 *  used by keyboard-shortcut troubleshooting. Verifies the trace agrees with
 *  resolveKeystroke and explains why each candidate was kept or skipped.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { KeybindingsRegistry } from '../../command/keybindingRegistry.js'
import { ContextKeyService } from '../../command/contextKey.js'
import type { IDisposable } from '../../base/lifecycle.js'

describe('KeybindingsRegistry.traceKeystroke', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('single-stroke hit: execute with the selected candidate', () => {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'save' }))

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s')
    expect(trace.kind).toBe('execute')
    if (trace.kind !== 'execute') throw new Error('unreachable')
    expect(trace.command).toBe('save')
    expect(trace.normalizedKey).toBe('ctrl+s')
    expect(trace.candidates).toHaveLength(1)
    expect(trace.candidates[0]).toMatchObject({
      command: 'save',
      selected: true,
      outcomeReason: 'matched',
    })
  })

  it('no binding registered: no-match with empty candidates', () => {
    const trace = KeybindingsRegistry.traceKeystroke('ctrl+alt+z')
    expect(trace.kind).toBe('no-match')
    expect(trace.candidates).toHaveLength(0)
  })

  it('when-clause fails: candidate kept with when-failed and key snapshot', () => {
    const ctx = new ContextKeyService()
    ctx.createKey<boolean>('editorFocus', false)
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+s',
        command: 'save',
        when: 'editorFocus',
      }),
    )

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s', ctx)
    expect(trace.kind).toBe('no-match')
    expect(trace.candidates).toHaveLength(1)
    expect(trace.candidates[0]).toMatchObject({
      command: 'save',
      selected: false,
      whenMatched: false,
      outcomeReason: 'when-failed',
      when: 'editorFocus',
    })
    expect(trace.candidates[0]!.whenKeys).toEqual([{ key: 'editorFocus', value: false }])
    ctx.dispose()
  })

  it('when-clause passes once the context key flips to true', () => {
    const ctx = new ContextKeyService()
    const k = ctx.createKey<boolean>('editorFocus', false)
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+s',
        command: 'save',
        when: 'editorFocus',
      }),
    )

    expect(KeybindingsRegistry.traceKeystroke('ctrl+s', ctx).kind).toBe('no-match')
    k.set(true)
    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s', ctx)
    expect(trace.kind).toBe('execute')
    expect(trace.candidates[0]).toMatchObject({ selected: true, whenMatched: true })
    ctx.dispose()
  })

  it('isNegated candidate is reported as is-negated, not selected', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'save', isNegated: true }),
    )

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s')
    expect(trace.kind).toBe('no-match')
    expect(trace.candidates[0]).toMatchObject({
      isNegated: true,
      selected: false,
      outcomeReason: 'is-negated',
    })
  })

  it('chord prefix: enter-chord and reports the chord candidate', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ chords: ['ctrl+k', 'ctrl+s'], command: 'openKb' }),
    )

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+k')
    expect(trace.kind).toBe('enter-chord')
    if (trace.kind !== 'enter-chord') throw new Error('unreachable')
    expect(trace.chordPending).toEqual(['ctrl+k'])
    expect(trace.candidates[0]).toMatchObject({ command: 'openKb', selected: true })
  })

  it('chord completion: execute when pending first stroke is supplied', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ chords: ['ctrl+k', 'ctrl+s'], command: 'openKb' }),
    )

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s', undefined, ['ctrl+k'])
    expect(trace.kind).toBe('execute')
    if (trace.kind !== 'execute') throw new Error('unreachable')
    expect(trace.command).toBe('openKb')
    expect(trace.pending).toEqual(['ctrl+k'])
    expect(trace.candidates[0]!.selected).toBe(true)
  })

  it('trace decision agrees with resolveKeystroke', () => {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'save' }))
    disposables.push(
      KeybindingsRegistry.registerKeybinding({ chords: ['ctrl+k', 'ctrl+o'], command: 'openKb' }),
    )

    for (const [key, pending] of [
      ['ctrl+s', undefined],
      ['ctrl+k', undefined],
      ['ctrl+o', ['ctrl+k']],
      ['ctrl+x', undefined],
    ] as const) {
      const resolved = KeybindingsRegistry.resolveKeystroke(key, undefined, pending)
      const trace = KeybindingsRegistry.traceKeystroke(key, undefined, pending)
      expect(trace.kind).toBe(resolved.kind)
      if (resolved.kind === 'execute' && trace.kind === 'execute') {
        expect(trace.command).toBe(resolved.command)
      }
    }
  })

  it('later registration wins and is the selected candidate', () => {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'first' }))
    disposables.push(KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'second' }))

    const trace = KeybindingsRegistry.traceKeystroke('ctrl+s')
    expect(trace.kind).toBe('execute')
    if (trace.kind !== 'execute') throw new Error('unreachable')
    expect(trace.command).toBe('second')
    const selected = trace.candidates.filter((c) => c.selected)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.command).toBe('second')
  })
})
