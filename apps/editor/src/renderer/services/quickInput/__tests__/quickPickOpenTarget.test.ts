import { describe, expect, it } from 'vitest'
import { resolveQuickPickOpenTarget } from '../quickPickOpenTarget.js'

describe('resolveQuickPickOpenTarget', () => {
  it('defaults to the active group', () => {
    expect(resolveQuickPickOpenTarget(undefined)).toBe('default')
    expect(resolveQuickPickOpenTarget({ ctrl: false, alt: false })).toBe('default')
  })

  it('maps Ctrl+Enter to the side group', () => {
    expect(resolveQuickPickOpenTarget({ ctrl: true, alt: false })).toBe('side')
  })

  it('maps Alt+Enter to a new window', () => {
    expect(resolveQuickPickOpenTarget({ ctrl: false, alt: true })).toBe('newWindow')
  })

  it('lets Alt win when both modifiers are held', () => {
    expect(resolveQuickPickOpenTarget({ ctrl: true, alt: true })).toBe('newWindow')
  })
})
