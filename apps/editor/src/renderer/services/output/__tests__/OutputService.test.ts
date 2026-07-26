import { describe, it, expect, vi } from 'vitest'
import {
  autorun,
  type IOutputChannelFlushEvent,
  type IStorageService,
} from '@universe-editor/platform'
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

/** Let queued microtask flushes run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

/** Mirror a channel's event stream into a plain string, the same way OutputModelService does. */
function mirror(channel: ReturnType<OutputService['createChannel']>): { text: () => string } {
  let text = channel.getText()
  channel.onDidFlush((e: IOutputChannelFlushEvent) => {
    text = (text + e.appendedText).slice(e.trimmedChars)
  })
  channel.onDidClear(() => {
    text = ''
  })
  return { text: () => text }
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

  it('activeChannelHasContent tracks the active channel', () => {
    const svc = new OutputService(makeStorage())
    const main = svc.createChannel('main')
    const debug = svc.createChannel('debug')

    expect(svc.activeChannelHasContent.get()).toBe(false)
    main.append('hello')
    expect(svc.activeChannelHasContent.get()).toBe(true)

    svc.setActiveChannel('debug')
    expect(svc.activeChannelHasContent.get()).toBe(false)

    debug.appendLine('error')
    expect(svc.activeChannelHasContent.get()).toBe(true)
  })

  it('getText includes appends synchronously (before flush)', () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    ch.append('hello')
    expect(ch.getText()).toBe('hello')
  })

  it('OutputChannel.clear empties content and fires onDidClear synchronously', () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    const clearSpy = vi.fn()
    ch.onDidClear(clearSpy)
    ch.append('xyz')
    ch.clear()
    expect(ch.getText()).toBe('')
    expect(ch.hasContent.get()).toBe(false)
    expect(clearSpy).toHaveBeenCalledTimes(1)
  })

  it('clear before the microtask flush drops the pending delta', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    const flushSpy = vi.fn()
    ch.onDidFlush(flushSpy)
    ch.append('xyz')
    ch.clear()
    await flushMicrotasks()
    expect(flushSpy).not.toHaveBeenCalled()
    expect(ch.getText()).toBe('')
  })

  it('batches same-tick appends into a single flush event', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    const events: IOutputChannelFlushEvent[] = []
    ch.onDidFlush((e) => events.push(e))

    ch.append('a')
    ch.append('b')
    ch.appendLine('c')
    await flushMicrotasks()

    expect(events).toEqual([{ appendedText: 'abc\n', trimmedChars: 0 }])
    expect(ch.getText()).toBe('abc\n')
  })

  it('flush event stream mirrors getText() exactly', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    const m = mirror(ch)
    for (let i = 0; i < 1000; i++) {
      ch.appendLine(`line ${i} with some payload to make each line non-trivial`)
      if (i % 7 === 0) await flushMicrotasks()
    }
    await flushMicrotasks()
    expect(m.text()).toBe(ch.getText())
  })

  it('OutputChannel caps retained content instead of growing unbounded', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    // Simulate a long-running ACP protocol trace: many lines appended over time.
    // Without a cap this string would grow without bound and eventually OOM the
    // renderer (observed: reason=oom in main.log during long agent sessions).
    for (let i = 0; i < 200_000; i++) {
      ch.appendLine(`line ${i} with some payload to make each line non-trivial`)
      if (i % 1000 === 0) await flushMicrotasks()
    }
    await flushMicrotasks()
    const content = ch.getText()
    // Retained content must stay bounded well below the tens-of-MB that crashed
    // the renderer. A few MB of scrollback is plenty for a log view.
    expect(content.length).toBeLessThanOrEqual(8 * 1024 * 1024)
    // The most recent line must survive the trim (we drop from the head).
    expect(content).toContain('line 199999')
  })

  it('OutputChannel trims on line boundaries so the log stays readable', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    for (let i = 0; i < 100_000; i++) ch.appendLine(`entry-${i}`)
    await flushMicrotasks()
    const content = ch.getText()
    // After a head-trim the retained content should begin at a clean line start,
    // not mid-line.
    expect(content.startsWith('entry-')).toBe(true)
  })

  it('trim events keep the mirror identical to getText() across the cap', async () => {
    const svc = new OutputService(makeStorage())
    const ch = svc.createChannel('main')
    const m = mirror(ch)
    // Push well past the 4MB cap + 256KB slack in multiple flushes.
    for (let i = 0; i < 150_000; i++) {
      ch.appendLine(`entry-${i} with a reasonably long payload line`)
      if (i % 500 === 0) await flushMicrotasks()
    }
    await flushMicrotasks()
    expect(m.text()).toBe(ch.getText())
    expect(m.text().length).toBeLessThanOrEqual(4.5 * 1024 * 1024)
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

  describe('channel dispose', () => {
    it('removes the channel from the registry and fires onDidRemoveChannel', () => {
      const svc = new OutputService(makeStorage())
      const removed: string[] = []
      svc.onDidRemoveChannel((n) => removed.push(n))
      const ch = svc.createChannel('main')
      svc.createChannel('debug')

      ch.dispose()
      expect(svc.channelNames.get()).toEqual(['debug'])
      expect(svc.getChannel('main')).toBeUndefined()
      expect(svc.getChannels().map((c) => c.name)).toEqual(['debug'])
      expect(removed).toEqual(['main'])
    })

    it('falls back to the first remaining channel when the active one is disposed', () => {
      const storage = makeStorage()
      const svc = new OutputService(storage)
      const main = svc.createChannel('main')
      svc.createChannel('debug')
      expect(svc.activeChannelName.get()).toBe('main')

      main.dispose()
      expect(svc.activeChannelName.get()).toBe('debug')
      expect(storage.set).toHaveBeenCalledWith('output.activeChannel', 'debug', expect.anything())
    })

    it('clears the active channel (and persisted key) when the last one is disposed', () => {
      const storage = makeStorage()
      const svc = new OutputService(storage)
      const main = svc.createChannel('main')

      main.dispose()
      expect(svc.activeChannelName.get()).toBeUndefined()
      expect(svc.activeChannel).toBeUndefined()
      expect(storage.remove).toHaveBeenCalledWith('output.activeChannel', expect.anything())
    })

    it('keeps a non-active channel selection when a background channel is disposed', () => {
      const svc = new OutputService(makeStorage())
      svc.createChannel('main')
      const debug = svc.createChannel('debug')
      svc.setActiveChannel('main')

      debug.dispose()
      expect(svc.activeChannelName.get()).toBe('main')
    })

    it('dispose is idempotent', () => {
      const svc = new OutputService(makeStorage())
      const removed: string[] = []
      svc.onDidRemoveChannel((n) => removed.push(n))
      const ch = svc.createChannel('main')

      ch.dispose()
      ch.dispose()
      expect(removed).toEqual(['main'])
      expect(svc.channelNames.get()).toEqual([])
    })

    it('a disposed channel ignores further appends', async () => {
      const svc = new OutputService(makeStorage())
      const ch = svc.createChannel('main')
      ch.dispose()
      ch.append('late')
      await flushMicrotasks()
      expect(ch.getText()).toBe('')
    })

    it('a same-named channel can be recreated after dispose', () => {
      const svc = new OutputService(makeStorage())
      const a = svc.createChannel('acp/claude/h1')
      a.append('old')
      a.dispose()

      const b = svc.createChannel('acp/claude/h1')
      expect(b).not.toBe(a)
      expect(b.getText()).toBe('')
      expect(svc.channelNames.get()).toEqual(['acp/claude/h1'])
    })

    it('service dispose removes all channels', () => {
      const svc = new OutputService(makeStorage())
      svc.createChannel('main')
      svc.createChannel('debug')
      svc.dispose()
      expect(svc.channelNames.get()).toEqual([])
      expect(svc.activeChannelName.get()).toBeUndefined()
    })
  })
})
