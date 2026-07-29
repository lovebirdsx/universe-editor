/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { ExtensionThemeRegistry } from '../themeRegistry.js'

interface TestTheme {
  id: string
  label?: string
  settingsId?: string
}

const theme = (id: string, settingsId?: string): TestTheme =>
  settingsId === undefined ? { id } : { id, settingsId }

describe('ExtensionThemeRegistry', () => {
  it('registers and finds themes by id and settingsId', () => {
    const registry = new ExtensionThemeRegistry<TestTheme>()
    registry.registerTheme(theme('vs-dark a', 'A'))
    registry.registerTheme(theme('vs b', 'B'))

    expect(registry.getThemes()).toHaveLength(2)
    expect(registry.findThemeById('vs-dark a')?.settingsId).toBe('A')
    expect(registry.findThemeBySettingsId('B')?.id).toBe('vs b')
    expect(registry.findThemeById('missing')).toBeUndefined()
    expect(registry.findThemeBySettingsId('missing')).toBeUndefined()
  })

  it('falls back to defaultId / defaultSettingsId when not found', () => {
    const registry = new ExtensionThemeRegistry<TestTheme>()
    registry.registerTheme(theme('vs-dark a', 'A'))
    expect(registry.findThemeById('missing', 'vs-dark a')?.settingsId).toBe('A')
    expect(registry.findThemeBySettingsId('missing', 'A')?.id).toBe('vs-dark a')
  })

  it('returns the built-in default theme for undefined queries', () => {
    const fallback = theme('vs-dark default', 'Default')
    const registry = new ExtensionThemeRegistry<TestTheme>(fallback)
    expect(registry.findThemeById(undefined)).toBe(fallback)
    expect(registry.findThemeById('missing')).toBe(fallback)
    expect(registry.findThemeBySettingsId(undefined)).toBe(fallback)
  })

  it('re-registering the same id replaces the entry and fires onDidChangeThemes', () => {
    const registry = new ExtensionThemeRegistry<TestTheme>()
    const events: number[] = []
    registry.onDidChangeThemes(() => events.push(1))

    registry.registerTheme(theme('vs-dark a', 'A'))
    registry.registerTheme(theme('vs-dark a', 'A2'))

    expect(registry.getThemes()).toHaveLength(1)
    expect(registry.findThemeById('vs-dark a')?.settingsId).toBe('A2')
    expect(events).toHaveLength(2)
  })

  it('deregisterTheme removes the entry and fires the event', () => {
    const registry = new ExtensionThemeRegistry<TestTheme>()
    const t = theme('vs-dark a', 'A')
    registry.registerTheme(t)
    let fired = 0
    registry.onDidChangeThemes(() => fired++)
    registry.deregisterTheme(t)
    expect(registry.getThemes()).toHaveLength(0)
    expect(fired).toBe(1)
  })
})
