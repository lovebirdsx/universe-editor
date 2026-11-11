import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_CLOSE_CONFIRM_STORAGE_KEY,
  SESSION_REMOVE_CONFIRM_STORAGE_KEY,
  isSessionCloseConfirmEnabled,
  isSessionRemoveConfirmEnabled,
  setSessionCloseConfirmEnabled,
  setSessionRemoveConfirmEnabled,
  shouldConfirmSessionClose,
} from '../sessionConfirm.js'

describe('sessionConfirm preferences', () => {
  it('defaults to asking before both close and remove', () => {
    expect(isSessionCloseConfirmEnabled()).toBe(true)
    expect(isSessionRemoveConfirmEnabled()).toBe(true)
  })

  it('persists the close preference without touching removal', () => {
    setSessionCloseConfirmEnabled(false)

    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('never')
    expect(isSessionCloseConfirmEnabled()).toBe(false)
    expect(isSessionRemoveConfirmEnabled()).toBe(true)
  })

  it('persists the remove preference without touching close', () => {
    setSessionRemoveConfirmEnabled(false)

    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBe('never')
    expect(isSessionRemoveConfirmEnabled()).toBe(false)
    expect(isSessionCloseConfirmEnabled()).toBe(true)
  })

  it('re-enables asking for both preferences', () => {
    setSessionCloseConfirmEnabled(false)
    setSessionRemoveConfirmEnabled(false)
    setSessionCloseConfirmEnabled(true)
    setSessionRemoveConfirmEnabled(true)

    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('ask')
    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBe('ask')
    expect(isSessionCloseConfirmEnabled()).toBe(true)
    expect(isSessionRemoveConfirmEnabled()).toBe(true)
  })

  it('falls back to asking for unknown stored values', () => {
    localStorage.setItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY, 'unexpected')
    localStorage.setItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY, 'unexpected')

    expect(isSessionCloseConfirmEnabled()).toBe(true)
    expect(isSessionRemoveConfirmEnabled()).toBe(true)
  })

  it('only confirms close when the scene needs it and the preference allows', () => {
    expect(shouldConfirmSessionClose(false)).toBe(false)
    expect(shouldConfirmSessionClose(true)).toBe(true)

    setSessionCloseConfirmEnabled(false)

    expect(shouldConfirmSessionClose(false)).toBe(false)
    expect(shouldConfirmSessionClose(true)).toBe(false)
  })

  it('keeps the default when storage writes fail', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    try {
      expect(() => setSessionCloseConfirmEnabled(false)).not.toThrow()
      expect(isSessionCloseConfirmEnabled()).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
