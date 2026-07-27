/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { AcpSessionRegistry } from '../acpSessionRegistry.js'
import type { AcpSession } from '../acpSession.js'

/**
 * Minimal stand-in for AcpSession: the registry only ever reads `id` and
 * `sessionIdOnAgent.get()`, never touches behaviour, so a plain object is
 * enough to exercise the CRUD + active-selection invariants in isolation.
 */
function fakeSession(id: string, agentId?: string): AcpSession {
  return {
    id,
    sessionIdOnAgent: { get: () => agentId },
  } as unknown as AcpSession
}

describe('AcpSessionRegistry', () => {
  it('starts empty', () => {
    const r = new AcpSessionRegistry()
    expect(r.sessions.get()).toEqual([])
    expect(r.activeSessionId.get()).toBeUndefined()
    expect(r.activeSession.get()).toBeUndefined()
    expect(r.all()).toEqual([])
  })

  it('add() appends and can activate atomically', () => {
    const r = new AcpSessionRegistry()
    const s = fakeSession('a')
    r.add(s, { activate: true })
    expect(r.sessions.get()).toEqual([s])
    expect(r.activeSessionId.get()).toBe('a')
    expect(r.activeSession.get()).toBe(s)
  })

  it('add() without activate leaves active untouched', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    const b = fakeSession('b')
    r.add(a, { activate: true })
    r.add(b, { activate: false })
    expect(r.sessions.get()).toEqual([a, b])
    expect(r.activeSessionId.get()).toBe('a')
    expect(r.activeSession.get()).toBe(a)
  })

  it('find() matches by local id or agent-issued id', () => {
    const r = new AcpSessionRegistry()
    const s = fakeSession('local-1', 'agent-1')
    r.add(s, { activate: false })
    expect(r.find('local-1')).toBe(s)
    expect(r.find('agent-1')).toBe(s)
    expect(r.find('nope')).toBeUndefined()
  })

  it('replace() swaps a same-id session and activates the new one', () => {
    const r = new AcpSessionRegistry()
    const old = fakeSession('x')
    const fresh = fakeSession('x')
    r.add(old, { activate: true })
    const prior = r.replace(fresh, { activate: true })
    expect(prior).toBe(old)
    expect(r.sessions.get()).toEqual([fresh])
    expect(r.activeSession.get()).toBe(fresh)
  })

  it('replace() with no prior just inserts', () => {
    const r = new AcpSessionRegistry()
    const fresh = fakeSession('x')
    const prior = r.replace(fresh, { activate: false })
    expect(prior).toBeUndefined()
    expect(r.sessions.get()).toEqual([fresh])
    expect(r.activeSession.get()).toBeUndefined()
  })

  it('remove() drops the session and reselects active when it was active', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    const b = fakeSession('b')
    r.add(a, { activate: true })
    r.add(b, { activate: false })
    r.setActive('a')
    r.remove('a')
    expect(r.sessions.get()).toEqual([b])
    // falls back to the first remaining session
    expect(r.activeSessionId.get()).toBe('b')
    expect(r.activeSession.get()).toBe(b)
  })

  it('remove() of a non-active session leaves active untouched', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    const b = fakeSession('b')
    r.add(a, { activate: true })
    r.add(b, { activate: false })
    r.remove('b')
    expect(r.sessions.get()).toEqual([a])
    expect(r.activeSessionId.get()).toBe('a')
    expect(r.activeSession.get()).toBe(a)
  })

  it('remove() of the last session clears active', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    r.add(a, { activate: true })
    r.remove('a')
    expect(r.sessions.get()).toEqual([])
    expect(r.activeSessionId.get()).toBeUndefined()
    expect(r.activeSession.get()).toBeUndefined()
  })

  it('setActive() by agent id resolves to the local id', () => {
    const r = new AcpSessionRegistry()
    const s = fakeSession('local-1', 'agent-1')
    r.add(s, { activate: false })
    r.setActive('agent-1')
    expect(r.activeSessionId.get()).toBe('local-1')
    expect(r.activeSession.get()).toBe(s)
  })

  it('setActive() for an unknown id is a no-op', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    r.add(a, { activate: true })
    r.setActive('nope')
    expect(r.activeSessionId.get()).toBe('a')
    expect(r.activeSession.get()).toBe(a)
  })

  it('clear() empties everything atomically and returns the prior sessions', () => {
    const r = new AcpSessionRegistry()
    const a = fakeSession('a')
    const b = fakeSession('b')
    r.add(a, { activate: true })
    r.add(b, { activate: false })
    const prior = r.clear()
    expect(prior).toEqual([a, b])
    expect(r.sessions.get()).toEqual([])
    expect(r.activeSessionId.get()).toBeUndefined()
    expect(r.activeSession.get()).toBeUndefined()
  })

  it('liveIds() returns local ids of all sessions', () => {
    const r = new AcpSessionRegistry()
    r.add(fakeSession('a'), { activate: false })
    r.add(fakeSession('b'), { activate: false })
    expect([...r.liveIds()].sort()).toEqual(['a', 'b'])
  })

  it('liveIds() also includes the agent-issued id so refresh-prune can protect just-created sessions', () => {
    const r = new AcpSessionRegistry()
    // A freshly-created session whose connection has attached: local uuid differs
    // from the agent-issued sessionId. Both must appear so the refresh-mode prune
    // (which keys preserveIds against the history row's id === sessionIdOnAgent)
    // does not drop it before the agent surfaces it in session/list.
    r.add(fakeSession('local-1', 'agent-1'), { activate: false })
    // A still-connecting session has no agent id yet — only the local id appears.
    r.add(fakeSession('local-2'), { activate: false })
    expect([...r.liveIds()].sort()).toEqual(['agent-1', 'local-1', 'local-2'])
  })
})
