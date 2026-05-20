import { describe, it, expect, vi } from 'vitest'
import { autorun } from '@universe-editor/platform'
import { OutputService } from '../OutputService.js'

describe('OutputService', () => {
  it('createChannel adds and auto-activates the first channel in one reaction', () => {
    const svc = new OutputService()
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
    const svc = new OutputService()
    svc.createChannel('main')
    svc.createChannel('debug')
    expect(svc.channelNames.get()).toEqual(['main', 'debug'])
    expect(svc.activeChannelName.get()).toBe('main')
  })

  it('createChannel is idempotent for the same name', () => {
    const svc = new OutputService()
    const a = svc.createChannel('main')
    const b = svc.createChannel('main')
    expect(a).toBe(b)
    expect(svc.channelNames.get()).toEqual(['main'])
  })

  it('setActiveChannel switches and rejects unknown', () => {
    const svc = new OutputService()
    svc.createChannel('main')
    svc.createChannel('debug')
    svc.setActiveChannel('debug')
    expect(svc.activeChannelName.get()).toBe('debug')

    svc.setActiveChannel('unknown')
    expect(svc.activeChannelName.get()).toBe('debug')
  })

  it('activeChannelContent tracks the active channel and its content', () => {
    const svc = new OutputService()
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
    const svc = new OutputService()
    const ch = svc.createChannel('main')
    ch.append('xyz')
    ch.clear()
    expect(ch.content.get()).toBe('')
  })
})
