import { describe, it, expect, afterEach, vi } from 'vitest'
import { AcpPromptRefInbox } from '../acpPromptRefInbox.js'
import type { PromptRef } from '../../promptRef.js'

const REF_A: PromptRef = { id: 'a', kind: 'file', label: 'src/a.ts', uri: 'file:///ws/src/a.ts' }
const REF_B: PromptRef = { id: 'b', kind: 'folder', label: 'src', uri: 'file:///ws/src' }

afterEach(() => AcpPromptRefInbox._resetForTests())

describe('AcpPromptRefInbox', () => {
  it('drains what was deposited, keyed by session id', () => {
    AcpPromptRefInbox.deposit('s1', [REF_A])
    expect(AcpPromptRefInbox.drain('s2')).toEqual([])
    expect(AcpPromptRefInbox.drain('s1')).toEqual([REF_A])
    // Draining is destructive.
    expect(AcpPromptRefInbox.drain('s1')).toEqual([])
  })

  it('accumulates across multiple deposits before a drain', () => {
    AcpPromptRefInbox.deposit('s1', [REF_A])
    AcpPromptRefInbox.deposit('s1', [REF_B])
    expect(AcpPromptRefInbox.drain('s1')).toEqual([REF_A, REF_B])
  })

  it('fires onDidDeposit with the session id, ignoring empty deposits', () => {
    const listener = vi.fn()
    const sub = AcpPromptRefInbox.onDidDeposit(listener)
    AcpPromptRefInbox.deposit('s1', [])
    expect(listener).not.toHaveBeenCalled()
    AcpPromptRefInbox.deposit('s1', [REF_A])
    expect(listener).toHaveBeenCalledWith('s1')
    sub.dispose()
  })
})
