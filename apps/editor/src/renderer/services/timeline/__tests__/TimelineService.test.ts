import { describe, expect, it, vi } from 'vitest'
import { ContextKeyService, URI, UriIdentityService } from '@universe-editor/platform'
import type { IExtHostTimeline } from '@universe-editor/extensions-common'
import { TimelineService } from '../TimelineService.js'

const FILE_A = URI.parse('file:///repo/a.ts')
const UNTITLED = URI.parse('untitled:Untitled-1')

function makeService() {
  const contextKeys = new ContextKeyService()
  const service = new TimelineService(contextKeys, new UriIdentityService('linux'))
  return { contextKeys, service }
}

describe('TimelineService', () => {
  it('tracks provider registrations and the timelineHasProvider context key', () => {
    const { contextKeys, service } = makeService()
    expect(service.providers.get()).toEqual([])
    expect(contextKeys.get('timelineHasProvider')).toBe(false)

    void service.$registerTimelineProvider(0, 'git-history', 'Git History', ['file'])
    expect(service.providers.get()).toEqual([
      { handle: 0, id: 'git-history', label: 'Git History', schemes: ['file'] },
    ])
    expect(contextKeys.get('timelineHasProvider')).toBe(true)

    void service.$unregisterTimelineProvider(0)
    expect(service.providers.get()).toEqual([])
    expect(contextKeys.get('timelineHasProvider')).toBe(false)
  })

  it('matches providers to uris by scheme', () => {
    const { service } = makeService()
    void service.$registerTimelineProvider(0, 'git-history', 'Git History', ['file'])
    void service.$registerTimelineProvider(1, 'other', 'Other', ['untitled'])

    expect(service.hasProviderForUri(FILE_A)).toBe(true)
    expect(service.hasProviderForUri(UNTITLED)).toBe(true)
    expect(service.getProvidersForUri(FILE_A).map((p) => p.id)).toEqual(['git-history'])
    expect(service.getProvidersForUri(UNTITLED).map((p) => p.id)).toEqual(['other'])
  })

  it('forwards getTimeline to the ext host proxy with the uri instance', async () => {
    const { service } = makeService()
    await expect(service.getTimeline(0, FILE_A, { limit: 10 })).resolves.toBeUndefined()

    const $provideTimeline = vi.fn(() => Promise.resolve(undefined))
    service.setExtHost({ $provideTimeline } satisfies IExtHostTimeline)
    await service.getTimeline(0, FILE_A, { limit: 10 })
    expect($provideTimeline).toHaveBeenCalledWith(0, FILE_A, { limit: 10 })
  })

  it('re-emits provider change events with the revived uri and source id', () => {
    const { service } = makeService()
    void service.$registerTimelineProvider(0, 'git-history', 'Git History', ['file'])
    const seen: { source: string; uri: string | undefined; reset: boolean }[] = []
    service.onDidChangeTimeline((e) =>
      seen.push({ source: e.source, uri: e.uri?.toString(), reset: e.reset }),
    )

    // Unknown handles are dropped.
    service.$emitTimelineChangeEvent(9, FILE_A.toJSON(), false)
    service.$emitTimelineChangeEvent(0, FILE_A.toJSON(), false)
    service.$emitTimelineChangeEvent(0, null, true)

    expect(seen).toEqual([
      { source: 'git-history', uri: FILE_A.toString(), reset: false },
      { source: 'git-history', uri: undefined, reset: true },
    ])
  })

  it('revives UriComponents and tolerates a null uri in change events', () => {
    const { service } = makeService()
    void service.$registerTimelineProvider(0, 'git-history', 'Git History', ['file'])
    const seen: { uri: URI | undefined; reset: boolean }[] = []
    service.onDidChangeTimeline((e) => seen.push({ uri: e.uri, reset: e.reset }))

    expect(() => service.$emitTimelineChangeEvent(0, null, true)).not.toThrow()
    service.$emitTimelineChangeEvent(0, FILE_A.toJSON(), false)

    expect(seen).toEqual([
      { uri: undefined, reset: true },
      { uri: FILE_A, reset: false },
    ])
    expect(seen[1]?.uri?.toString()).toBe(FILE_A.toString())
  })

  it('pin blocks follow until unpin', () => {
    const { service } = makeService()
    const fileB = URI.parse('file:///repo/b.ts')

    service.followUri(FILE_A)
    expect(service.uri.get()?.toString()).toBe(FILE_A.toString())

    service.pinUri(FILE_A)
    service.followUri(fileB)
    expect(service.uri.get()?.toString()).toBe(FILE_A.toString())
    expect(service.pinnedUri.get()?.toString()).toBe(FILE_A.toString())

    service.unpin()
    service.followUri(fileB)
    expect(service.uri.get()?.toString()).toBe(fileB.toString())
    expect(service.pinnedUri.get()).toBeUndefined()
  })

  it('followUri keeps the current value when the same file arrives as a fresh instance', () => {
    const { service } = makeService()
    service.followUri(FILE_A)
    const before = service.uri.get()

    service.followUri(URI.parse('file:///repo/a.ts'))
    expect(service.uri.get()).toBe(before)

    service.followUri(undefined)
    expect(service.uri.get()).toBeUndefined()
  })

  it('reset drops providers, the ext host proxy and the follow state', async () => {
    const { service } = makeService()
    void service.$registerTimelineProvider(0, 'git-history', 'Git History', ['file'])
    service.setExtHost({ $provideTimeline: vi.fn(() => Promise.resolve(undefined)) })
    service.pinUri(FILE_A)

    service.reset()

    expect(service.providers.get()).toEqual([])
    expect(service.uri.get()).toBeUndefined()
    expect(service.pinnedUri.get()).toBeUndefined()
    await expect(service.getTimeline(0, FILE_A, {})).resolves.toBeUndefined()
  })
})
