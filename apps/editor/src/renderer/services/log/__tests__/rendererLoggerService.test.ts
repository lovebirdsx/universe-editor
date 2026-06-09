/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/log/rendererLoggerService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { LogLevel } from '@universe-editor/platform'
import type { ILogChannelService, LogEntry } from '../../../../shared/ipc/services.js'
import { RendererLoggerService } from '../rendererLoggerService.js'

function makeProxy(): ILogChannelService & {
  append: ReturnType<typeof vi.fn>
  appendBatch: ReturnType<typeof vi.fn>
} {
  return {
    _serviceBrand: undefined,
    append: vi.fn().mockResolvedValue(undefined),
    appendBatch: vi.fn().mockResolvedValue(undefined),
  }
}

describe('RendererLoggerService batching', () => {
  it('coalesces many synchronous log entries into a single IPC call', async () => {
    const proxy = makeProxy()
    const svc = new RendererLoggerService(proxy)
    const logger = svc.createLogger({ id: 'editor', name: 'Editor' })

    for (let i = 0; i < 100; i++) logger.info(`entry-${i}`)
    await svc.flush()

    expect(proxy.append).not.toHaveBeenCalled()
    expect(proxy.appendBatch).toHaveBeenCalledTimes(1)
    const [entries] = proxy.appendBatch.mock.calls[0] as [readonly LogEntry[]]
    expect(entries).toHaveLength(100)
    expect(entries[0]?.message).toBe('entry-0')
    expect(entries[99]?.message).toBe('entry-99')
  })

  it('captures a fire-time timestamp on each entry', async () => {
    const proxy = makeProxy()
    const svc = new RendererLoggerService(proxy)
    const logger = svc.createLogger({ id: 'editor', name: 'Editor' })

    const before = Date.now()
    logger.warn('one')
    const after = Date.now()
    await svc.flush()

    const [entries] = proxy.appendBatch.mock.calls[0] as [readonly LogEntry[]]
    expect(entries[0]?.level).toBe(LogLevel.Warning)
    expect(entries[0]?.timestamp).toBeGreaterThanOrEqual(before)
    expect(entries[0]?.timestamp).toBeLessThanOrEqual(after)
  })

  it('flush awaits in-flight IPC work even when the local queue is empty', async () => {
    const proxy = makeProxy()
    let resolveBatch: (() => void) | undefined
    proxy.appendBatch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveBatch = resolve
        }),
    )
    const svc = new RendererLoggerService(proxy)
    const logger = svc.createLogger({ id: 'editor', name: 'Editor' })
    logger.info('hello')

    // Allow the microtask to dispatch the in-flight call
    await Promise.resolve()
    const flushDone = svc.flush()
    let resolved = false
    void flushDone.then(() => {
      resolved = true
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)

    if (resolveBatch) (resolveBatch as () => void)()
    await flushDone
    expect(resolved).toBe(true)
  })
})
