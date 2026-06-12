/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the QuickAccess provider registry (longest-prefix routing) and the
 *  keybinding `args` round-trip that lets `quickOpen` open in a prefixed mode.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { QuickAccessRegistry, type IQuickAccessProvider } from '../../workbench/quickAccess.js'
import { KeybindingsRegistry } from '../../command/keybindingRegistry.js'
import type { IDisposable } from '../../base/lifecycle.js'

// A bare provider stand-in; routing only cares about the descriptor, never the ctor.
class NoopProvider implements IQuickAccessProvider {
  provide(): void {}
}

describe('QuickAccessRegistry routing', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  function register(prefix: string): void {
    disposables.push(
      QuickAccessRegistry.registerQuickAccessProvider({
        ctor: NoopProvider,
        prefix,
        placeholder: `placeholder:${prefix}`,
      }),
    )
  }

  function registerAll(): void {
    register('')
    register('@')
    register('@:')
    register('>')
    register('#')
  }

  it('empty value routes to the default ("") provider', () => {
    registerAll()
    expect(QuickAccessRegistry.getQuickAccessProvider('')?.prefix).toBe('')
    expect(QuickAccessRegistry.getDefaultProvider()?.prefix).toBe('')
  })

  it('plain text routes to the default provider', () => {
    registerAll()
    expect(QuickAccessRegistry.getQuickAccessProvider('abc')?.prefix).toBe('')
  })

  it('"@:" is not swallowed by "@" (longest prefix wins)', () => {
    registerAll()
    expect(QuickAccessRegistry.getQuickAccessProvider('@:x')?.prefix).toBe('@:')
    expect(QuickAccessRegistry.getQuickAccessProvider('@:')?.prefix).toBe('@:')
  })

  it('"@x" routes to the "@" provider', () => {
    registerAll()
    expect(QuickAccessRegistry.getQuickAccessProvider('@x')?.prefix).toBe('@')
  })

  it('">" and "#" route to their providers', () => {
    registerAll()
    expect(QuickAccessRegistry.getQuickAccessProvider('>fmt')?.prefix).toBe('>')
    expect(QuickAccessRegistry.getQuickAccessProvider('#sym')?.prefix).toBe('#')
  })

  it('longest-prefix order holds regardless of registration order', () => {
    register('@')
    register('@:')
    register('')
    expect(QuickAccessRegistry.getQuickAccessProvider('@:x')?.prefix).toBe('@:')
  })

  it('disposing a descriptor unregisters it', () => {
    const d = QuickAccessRegistry.registerQuickAccessProvider({
      ctor: NoopProvider,
      prefix: '>',
      placeholder: 'cmds',
    })
    expect(QuickAccessRegistry.getQuickAccessProvider('>x')?.prefix).toBe('>')
    d.dispose()
    // No default registered → falls back to undefined once '>' is gone.
    expect(QuickAccessRegistry.getQuickAccessProvider('>x')).toBeUndefined()
  })

  it('falls back to undefined when nothing matches and no default exists', () => {
    register('@')
    expect(QuickAccessRegistry.getQuickAccessProvider('abc')).toBeUndefined()
  })
})

describe('keybinding args round-trip', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('resolveKeystroke carries args from a single-stroke binding', () => {
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+r',
        command: 'workbench.action.quickOpen',
        args: '@:',
      }),
    )

    const resolution = KeybindingsRegistry.resolveKeystroke('ctrl+r')
    expect(resolution.kind).toBe('execute')
    if (resolution.kind !== 'execute') throw new Error('unreachable')
    expect(resolution.command).toBe('workbench.action.quickOpen')
    expect(resolution.args).toBe('@:')
  })

  it('omits args when the binding has none', () => {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key: 'ctrl+s', command: 'save' }))

    const resolution = KeybindingsRegistry.resolveKeystroke('ctrl+s')
    expect(resolution.kind).toBe('execute')
    if (resolution.kind !== 'execute') throw new Error('unreachable')
    expect(resolution.args).toBeUndefined()
  })
})
