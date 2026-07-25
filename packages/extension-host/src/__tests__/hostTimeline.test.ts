import { describe, expect, it, vi } from 'vitest'
import type { IMainThreadTimeline } from '@universe-editor/extensions-common'
import type { TimelineChangeEvent, TimelineProvider } from '@universe-editor/extension-api'
import { ExtHostTimelineRegistry } from '../hostTimeline.js'

function fakeMainThread() {
  return {
    $registerTimelineProvider: vi.fn(() => Promise.resolve()),
    $unregisterTimelineProvider: vi.fn(() => Promise.resolve()),
    $emitTimelineChangeEvent: vi.fn(),
  } satisfies IMainThreadTimeline
}

function fakeProvider(overrides: Partial<TimelineProvider> = {}): TimelineProvider {
  return {
    id: 'git-history',
    label: 'Git History',
    provideTimeline: vi.fn(() => Promise.resolve({ items: [] })),
    ...overrides,
  }
}

describe('ExtHostTimelineRegistry', () => {
  it('allocates incrementing handles and forwards registrations', () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)

    registry.registerTimelineProvider(['file'], fakeProvider())
    registry.registerTimelineProvider(['file', 'untitled'], fakeProvider({ id: 'other' }))

    expect(mainThread.$registerTimelineProvider).toHaveBeenNthCalledWith(
      1,
      0,
      'git-history',
      'Git History',
      ['file'],
    )
    expect(mainThread.$registerTimelineProvider).toHaveBeenNthCalledWith(
      2,
      1,
      'other',
      'Git History',
      ['file', 'untitled'],
    )
  })

  it('unregisters on dispose of the returned disposable; double dispose is a no-op', () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)

    const d = registry.registerTimelineProvider(['file'], fakeProvider())
    d.dispose()
    d.dispose()

    expect(mainThread.$unregisterTimelineProvider).toHaveBeenCalledTimes(1)
    expect(mainThread.$unregisterTimelineProvider).toHaveBeenCalledWith(0)
  })

  it('forwards provider onDidChange events and stops after dispose', () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)
    let fire: ((e: TimelineChangeEvent) => void) | undefined
    const provider = fakeProvider({
      onDidChange: (listener) => {
        fire = listener
        return { dispose: () => (fire = undefined) }
      },
    })

    const d = registry.registerTimelineProvider(['file'], provider)
    fire?.({ uri: 'file:///a.ts', reset: false })
    expect(mainThread.$emitTimelineChangeEvent).toHaveBeenCalledWith(0, 'file:///a.ts', false)

    d.dispose()
    expect(fire).toBeUndefined()
  })

  it('routes provideTimeline by handle and maps items to DTOs', async () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)
    const provider = fakeProvider({
      provideTimeline: vi.fn(() =>
        Promise.resolve({
          items: [
            {
              id: 'abc123',
              label: 'fix: thing',
              description: '2 hours ago',
              timestamp: 1700000000000,
              themeIcon: 'git-commit',
              contextValue: 'git:file:commit',
              command: {
                command: 'git.timeline.openDiff',
                title: 'Open Comparison',
                arguments: [{ uri: '/a.ts', currentHash: 'abc123' }],
              },
            },
            { label: 'Uncommitted Changes', timestamp: 1700000010000 },
          ],
          cursor: 'def456',
        }),
      ),
    })
    registry.registerTimelineProvider(['file'], provider)

    const dto = await registry.provideTimeline(0, 'file:///a.ts', { limit: 50 })

    expect(provider.provideTimeline).toHaveBeenCalledWith(
      'file:///a.ts',
      { limit: 50 },
      expect.objectContaining({ isCancellationRequested: false }),
    )
    expect(dto?.source).toBe('git-history')
    expect(dto?.cursor).toBe('def456')
    expect(dto?.items[0]).toEqual({
      handle: 'git-history|abc123',
      source: 'git-history',
      id: 'abc123',
      label: 'fix: thing',
      description: '2 hours ago',
      timestamp: 1700000000000,
      themeIcon: 'git-commit',
      contextValue: 'git:file:commit',
      command: {
        command: 'git.timeline.openDiff',
        title: 'Open Comparison',
        arguments: [{ uri: '/a.ts', currentHash: 'abc123' }],
      },
    })
    // No id → the handle falls back to the timestamp.
    expect(dto?.items[1]?.handle).toBe('git-history|1700000010000')
  })

  it('returns undefined for unknown handles and provider-less results', async () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)
    registry.registerTimelineProvider(['file'], fakeProvider())

    await expect(registry.provideTimeline(99, 'file:///a.ts', {})).resolves.toBeUndefined()
  })

  it('dispose unregisters every provider', () => {
    const mainThread = fakeMainThread()
    const registry = new ExtHostTimelineRegistry(mainThread)
    registry.registerTimelineProvider(['file'], fakeProvider())
    registry.registerTimelineProvider(['file'], fakeProvider({ id: 'other' }))

    registry.dispose()

    expect(mainThread.$unregisterTimelineProvider).toHaveBeenCalledWith(0)
    expect(mainThread.$unregisterTimelineProvider).toHaveBeenCalledWith(1)
  })
})
