import { describe, it, expect, vi } from 'vitest'
import { autorun, type IStorageService } from '@universe-editor/platform'
import { OutputService } from '../OutputService.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

describe('OutputService', () => {
  it('createChannel adds and auto-activates the first channel in one reaction', () => {
    const svc = new OutputService(makeStorage())
    const spy = vi.fn()
    const d = autorun((r) => {
      svc.channelNames.read(r)
      svc.activeChannelName.read(r)
      spy()
    })
    spy.mockClear()

    svc.createChannel('main')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(svc.channelNames.get()).toEqual(['main'])
    expect(svc.activeChannelName.get()).toBe('main')
    d.dispose()
  })

  it('subsequent createChannel does not change active channel', () => {
    const svc = new OutputService(makeStorage())
    svc.createChannel('main')
    svc.createChannel('debug')
    expect(svc.channelNames.get()).toEqual(['main', 'debug'])
    expect(svc.activeChannelName.get()).toBe('main')
  })

  it('createChannel is idempotent for the same name', () => {
    const svc = new OutputService(makeStorage())
    const a = svc.createChannel('main')
    const b = svc.createChannel('main')
    expect(a).toBe(b)
    expect(svc.channelNames.get()).toEqual(['main'])
  })

  it('setActiveChannel switches and rejects unknown', () => {
    const svc = new OutputService(makeStorage())
    svc.createChannel('main')
    svc.createChannel('debug')
    svc.setActiveChannel('debug')
    expect(svc.activeChannelName.get()).toBe('debug')

    svc.setActiveChannel('unknown')
    expect(svc.activeChannelName.get()).toBe('debug')
  })

  it('activeChannelContent tracks the active channel and its content', () => {
    const svc = new OutputService(makeStorage())
    const main = svc.createChannel('main')
    const debug = svc.createChannel('debug')

    main.append('hello')
    expect(svc.activeChannelContent.get()).toBe('hello')

    svc.setActiveChannel('debug')
    expect(svc.activeChannelContent.get()).toBe('')

    debug.appendLine('error')
    expect(svc.activeChannelContent.get()).toBe('error\n')
  })

  it('OutputChannel.clear empties content', () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    ch.append('xyz')
    ch.clear()
    expect(ch.content.get()).toBe('')
  })

  it('pending restored channel activates when created later (stable name)', () => {
    const storage = makeStorage()
    // Simulate a previous session that had "debug" active.
    ;(storage.get as ReturnType<typeof vi.fn>).mockResolvedValue('debug')
    const svc = new OutputService(storage)
    svc.createChannel('main') // first channel — becomes active by default
    expect(svc.activeChannelName.get()).toBe('main')

    // "debug" channel is created after the async restore resolves (microtask).
    // We verify the pending mechanism by simulating it: set _pendingRestoredChannelName
    // directly via the internal state via calling _loadRestoredChannel indirectly.
    // The simplest unit-level proof: flush the microtask and create the channel.
    return Promise.resolve().then(async () => {
      await Promise.resolve() // let _loadRestoredChannel resolve
      svc.createChannel('debug')
      expect(svc.activeChannelName.get()).toBe('debug')
    })
  })

  it('pending ACP channel activates when a new handle is created (prefix match)', () => {
    const storage = makeStorage()
    ;(storage.get as ReturnType<typeof vi.fn>).mockResolvedValue('acp/claude/old-handle')
    const svc = new OutputService(storage)
    svc.createChannel('main')
    expect(svc.activeChannelName.get()).toBe('main')

    return Promise.resolve().then(async () => {
      await Promise.resolve() // let _loadRestoredChannel resolve
      // New session creates a channel with a DIFFERENT handle for the same agent.
      svc.createChannel('acp/claude/new-handle')
      expect(svc.activeChannelName.get()).toBe('acp/claude/new-handle')
    })
  })

  it('pending ACP channel does NOT activate a channel for a different agent', () => {
    const storage = makeStorage()
    ;(storage.get as ReturnType<typeof vi.fn>).mockResolvedValue('acp/claude/old-handle')
    const svc = new OutputService(storage)
    svc.createChannel('main')

    return Promise.resolve().then(async () => {
      await Promise.resolve()
      svc.createChannel('acp/gpt/some-handle') // different agentId
      expect(svc.activeChannelName.get()).toBe('main') // unchanged
    })
  })

  it('setActiveChannel saves to storage', () => {
    const storage = makeStorage()
    const svc = new OutputService(storage)
    svc.createChannel('main')
    svc.createChannel('debug')
    svc.setActiveChannel('debug')
    expect(storage.set).toHaveBeenCalledWith('output.activeChannel', 'debug', expect.anything())
  })
})
