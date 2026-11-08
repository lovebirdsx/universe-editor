import { describe, expect, it, vi } from 'vitest'
import {
  leaveSession,
  navigateToNewSession,
  navigateToSession,
  readRoute,
  sessionPath,
} from '../routing.js'

describe('readRoute', () => {
  it.each([
    ['/', { name: 'inbox' }],
    ['/pair', { name: 'pair' }],
    ['/new', { name: 'new-session' }],
    ['/s/', { name: 'inbox' }],
    ['/s/1%3As1', { name: 'session', sessionKey: '1:s1' }],
    ['/s/durable%2Fid%20x', { name: 'session', sessionKey: 'durable/id x' }],
    ['/unknown', { name: 'inbox' }],
  ] as const)('reads %s', (path, expected) => {
    expect(readRoute(path)).toEqual(expected)
  })

  it('treats malformed percent-encoding as the inbox', () => {
    expect(readRoute('/s/%E0%A4%A')).toEqual({ name: 'inbox' })
  })

  it('round-trips a session key through the URL', () => {
    const key = 'durable/with spaces:1'
    expect(readRoute(sessionPath(key))).toEqual({ name: 'session', sessionKey: key })
  })
})

describe('navigation', () => {
  it('pushes an encoded /s/ path with an in-app marker', () => {
    const pushState = vi.fn()
    navigateToSession('a:b', { pushState })
    expect(pushState).toHaveBeenCalledWith({ mobile: true }, '', '/s/a%3Ab')
  })

  it('pushes the new-session path', () => {
    const pushState = vi.fn()
    navigateToNewSession({ pushState })
    expect(pushState).toHaveBeenCalledWith({ mobile: true }, '', '/new')
  })

  it('goes back when the current entry was opened in-app', () => {
    const back = vi.fn()
    const replaceState = vi.fn()
    leaveSession({ state: { mobile: true }, back, replaceState })
    expect(back).toHaveBeenCalledTimes(1)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('replaces a cold-loaded session URL with the inbox', () => {
    const back = vi.fn()
    const replaceState = vi.fn()
    const listener = vi.fn()
    window.addEventListener('popstate', listener)
    try {
      leaveSession({ state: null, back, replaceState })
      expect(back).not.toHaveBeenCalled()
      expect(replaceState).toHaveBeenCalledWith(null, '', '/')
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('popstate', listener)
    }
  })
})
