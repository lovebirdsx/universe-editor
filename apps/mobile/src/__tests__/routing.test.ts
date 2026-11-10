import { describe, expect, it, vi } from 'vitest'
import {
  leaveSession,
  leaveSessions,
  navigateToNewSession,
  navigateToSession,
  navigateToSessions,
  readRoute,
  replaceWithSession,
  sessionPath,
} from '../routing.js'

describe('readRoute', () => {
  it.each([
    ['/', { name: 'inbox' }],
    ['/pair', { name: 'pair' }],
    ['/new', { name: 'new-session' }],
    ['/sessions', { name: 'sessions' }],
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
    navigateToSession('a:b', { pushState, state: null })
    expect(pushState).toHaveBeenCalledWith({ mobile: true, depth: 1 }, '', '/s/a%3Ab')
  })

  it('increments the in-app depth', () => {
    const pushState = vi.fn()
    navigateToSessions({ pushState, state: { mobile: true, depth: 2 } })
    expect(pushState).toHaveBeenCalledWith({ mobile: true, depth: 3 }, '', '/sessions')
  })

  it('pushes the new-session path', () => {
    const pushState = vi.fn()
    navigateToNewSession({ pushState, state: null })
    expect(pushState).toHaveBeenCalledWith({ mobile: true, depth: 1 }, '', '/new')
  })

  it('pushes the sessions path', () => {
    const pushState = vi.fn()
    navigateToSessions({ pushState, state: null })
    expect(pushState).toHaveBeenCalledWith({ mobile: true, depth: 1 }, '', '/sessions')
  })

  it('replaces the new-session entry with the created session', () => {
    const replaceState = vi.fn()
    replaceWithSession('a:b', { replaceState, state: { mobile: true, depth: 1 } })
    expect(replaceState).toHaveBeenCalledWith({ mobile: true, depth: 1 }, '', '/s/a%3Ab')
  })

  it('goes back when the current entry was opened in-app', () => {
    const back = vi.fn()
    const replaceState = vi.fn()
    leaveSession({ state: { mobile: true, depth: 2 }, back, replaceState })
    expect(back).toHaveBeenCalledTimes(1)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('falls back to the inbox when there is no in-app predecessor', () => {
    const back = vi.fn()
    const replaceState = vi.fn()
    const listener = vi.fn()
    window.addEventListener('popstate', listener)
    try {
      // A notification deep link pushed on top of the cold-start root entry.
      leaveSession({ state: { mobile: true, depth: 1 }, back, replaceState })
      expect(back).not.toHaveBeenCalled()
      expect(replaceState).toHaveBeenCalledWith(null, '', '/')
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('popstate', listener)
    }
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

  it('leaves the sessions page the same way', () => {
    const back = vi.fn()
    leaveSessions({ state: { mobile: true, depth: 2 }, back, replaceState: vi.fn() })
    expect(back).toHaveBeenCalledTimes(1)
  })
})
