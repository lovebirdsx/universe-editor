import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureNls, getCurrentLocale, localize, localize2 } from '../../nls/nls.js'

describe('nls', () => {
  afterEach(() => {
    configureNls({ locale: 'en-US' })
    vi.restoreAllMocks()
  })

  it('returns the configured translation for the active locale', () => {
    configureNls({
      locale: 'zh-CN',
      messages: { hello: '你好' },
      fallbackMessages: { hello: 'Hello' },
    })

    expect(getCurrentLocale()).toBe('zh-CN')
    expect(localize('hello', 'Hello')).toBe('你好')
  })

  it('falls back to the provided default message when no translation exists', () => {
    configureNls({ locale: 'en-US' })

    expect(localize('missing.key', 'Fallback')).toBe('Fallback')
  })

  it('formats named placeholders', () => {
    configureNls({
      locale: 'en-US',
      messages: { greet: 'Hello, {name}!' },
    })

    expect(localize('greet', 'Hello, {name}!', { name: 'Universe' })).toBe('Hello, Universe!')
  })

  it('does not warn when warnOnMissing is disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configureNls({
      locale: 'en-US',
      messages: { known: 'Known' },
      warnOnMissing: false,
    })

    expect(localize('unknown', 'Unknown')).toBe('Unknown')
    expect(warn).not.toHaveBeenCalled()
  })

  describe('localize2', () => {
    it('returns the translated value and the original English form', () => {
      configureNls({
        locale: 'zh-CN',
        messages: { hello: '你好' },
        fallbackMessages: { hello: 'Hello' },
      })

      expect(localize2('hello', 'Hello')).toEqual({ value: '你好', original: 'Hello' })
    })

    it('formats placeholders in both value and original', () => {
      configureNls({
        locale: 'zh-CN',
        messages: { greet: '你好，{name}！' },
      })

      expect(localize2('greet', 'Hello, {name}!', { name: 'Universe' })).toEqual({
        value: '你好，Universe！',
        original: 'Hello, Universe!',
      })
    })

    it('original equals the default message even when no translation exists', () => {
      configureNls({ locale: 'en-US' })

      expect(localize2('missing.key', 'Fallback')).toEqual({
        value: 'Fallback',
        original: 'Fallback',
      })
    })
  })
})
