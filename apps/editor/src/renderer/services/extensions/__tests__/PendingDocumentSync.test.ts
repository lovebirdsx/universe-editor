/**
 * Regression: a completion trigger char (`#`) fires before the 200ms document
 * sync debounce, so the host would parse a stale line and return no headers.
 * PendingDocumentSync lets the completion proxy await a flush of the just-typed
 * text first. See DocumentSyncContribution / languageProviderProxy.
 */
import { describe, expect, it, vi } from 'vitest'
import { PendingDocumentSync } from '../PendingDocumentSync.js'

const URI = 'file:///ws/bar.md'

describe('PendingDocumentSync', () => {
  it('awaits the registered flush for a uri', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    PendingDocumentSync.register(URI, flush)
    await PendingDocumentSync.flush(URI)
    expect(flush).toHaveBeenCalledTimes(1)
    PendingDocumentSync.unregister(URI)
  })

  it('is a no-op for an untracked uri', async () => {
    await expect(PendingDocumentSync.flush('file:///ws/never.md')).resolves.toBeUndefined()
  })

  it('stops flushing after unregister', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    PendingDocumentSync.register(URI, flush)
    PendingDocumentSync.unregister(URI)
    await PendingDocumentSync.flush(URI)
    expect(flush).not.toHaveBeenCalled()
  })

  it('propagates the flush promise so callers wait for the host push', async () => {
    let resolved = false
    PendingDocumentSync.register(URI, async () => {
      await new Promise((r) => setTimeout(r, 10))
      resolved = true
    })
    await PendingDocumentSync.flush(URI)
    expect(resolved).toBe(true)
    PendingDocumentSync.unregister(URI)
  })
})
