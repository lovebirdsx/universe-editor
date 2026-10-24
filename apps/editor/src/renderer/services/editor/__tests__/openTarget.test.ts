import { describe, expect, it } from 'vitest'
import { resolveOpenTarget, resolveQuickPickOpenTarget, type OpenTarget } from '../openTarget.js'

describe('resolveOpenTarget', () => {
  it('defaults to the active group', () => {
    expect(resolveOpenTarget(undefined)).toBe<OpenTarget>('default')
    expect(resolveOpenTarget({ ctrl: false, meta: false, alt: false })).toBe('default')
  })

  it('maps Ctrl or Meta to the side group', () => {
    expect(resolveOpenTarget({ ctrl: true })).toBe('side')
    expect(resolveOpenTarget({ meta: true })).toBe('side')
  })

  it('maps Alt to a new window', () => {
    expect(resolveOpenTarget({ alt: true })).toBe('newWindow')
  })

  it('lets Alt win when both modifiers are held', () => {
    expect(resolveOpenTarget({ ctrl: true, alt: true })).toBe('newWindow')
    expect(resolveOpenTarget({ meta: true, alt: true })).toBe('newWindow')
  })

  it('reads DOM event modifier keys directly', () => {
    expect(resolveOpenTarget({ ctrlKey: true })).toBe('side')
    expect(resolveOpenTarget({ metaKey: true })).toBe('side')
    expect(resolveOpenTarget({ altKey: true })).toBe('newWindow')
    expect(resolveOpenTarget({ ctrlKey: true, altKey: true })).toBe('newWindow')
    expect(resolveOpenTarget({ ctrlKey: false, metaKey: false, altKey: false })).toBe('default')
  })
})

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
