import { describe, it, expect, afterEach, vi } from 'vitest'
import { AcpPromptTextInbox } from '../acpPromptTextInbox.js'

afterEach(() => AcpPromptTextInbox._resetForTests())

describe('AcpPromptTextInbox', () => {
  it('drains what was deposited, keyed by session id', () => {
    AcpPromptTextInbox.deposit('s1', 'hello')
    expect(AcpPromptTextInbox.drain('s2')).toEqual([])
    expect(AcpPromptTextInbox.drain('s1')).toEqual(['hello'])
    // Draining is destructive.
    expect(AcpPromptTextInbox.drain('s1')).toEqual([])
  })

  it('accumulates across multiple deposits before a drain', () => {
    AcpPromptTextInbox.deposit('s1', 'a')
    AcpPromptTextInbox.deposit('s1', 'b')
    expect(AcpPromptTextInbox.drain('s1')).toEqual(['a', 'b'])
  })

  it('fires onDidDeposit with the session id, ignoring blank deposits', () => {
    const listener = vi.fn()
    const sub = AcpPromptTextInbox.onDidDeposit(listener)
    AcpPromptTextInbox.deposit('s1', '   ')
    expect(listener).not.toHaveBeenCalled()
    AcpPromptTextInbox.deposit('s1', 'x')
    expect(listener).toHaveBeenCalledWith('s1')
    sub.dispose()
  })
})
