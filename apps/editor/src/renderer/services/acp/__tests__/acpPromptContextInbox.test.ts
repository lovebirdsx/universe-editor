import { describe, it, expect, afterEach, vi } from 'vitest'
import { AcpPromptContextInbox } from '../acpPromptContextInbox.js'
import type { SelectionContext } from '../promptContext.js'

const CTX: SelectionContext = {
  uri: 'file:///w/src/a.ts',
  relPath: 'src/a.ts',
  text: 'const x = 1',
  startLine: 12,
  endLine: 40,
  languageId: 'typescript',
}

afterEach(() => AcpPromptContextInbox._resetForTests())

describe('AcpPromptContextInbox', () => {
  it('drains what was deposited, keyed by session id', () => {
    AcpPromptContextInbox.deposit('s1', [CTX])
    expect(AcpPromptContextInbox.drain('s2')).toEqual([])
    expect(AcpPromptContextInbox.drain('s1')).toEqual([CTX])
    // Draining is destructive.
    expect(AcpPromptContextInbox.drain('s1')).toEqual([])
  })

  it('accumulates across multiple deposits before a drain', () => {
    const second = { ...CTX, relPath: 'src/b.ts' }
    AcpPromptContextInbox.deposit('s1', [CTX])
    AcpPromptContextInbox.deposit('s1', [second])
    expect(AcpPromptContextInbox.drain('s1')).toEqual([CTX, second])
  })

  it('fires onDidDeposit with the session id, ignoring empty deposits', () => {
    const listener = vi.fn()
    const sub = AcpPromptContextInbox.onDidDeposit(listener)
    AcpPromptContextInbox.deposit('s1', [])
    expect(listener).not.toHaveBeenCalled()
    AcpPromptContextInbox.deposit('s1', [CTX])
    expect(listener).toHaveBeenCalledWith('s1')
    sub.dispose()
  })
})
