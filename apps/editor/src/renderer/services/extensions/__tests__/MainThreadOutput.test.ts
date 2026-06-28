/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadOutput: bridging the host's OutputChannel RPC to the
 *  editor's output service + panel layout.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  PartId,
  type ILayoutService,
  type IOutputChannel,
  type IOutputService,
  type IViewsService,
} from '@universe-editor/platform'
import { MainThreadOutput } from '../MainThreadOutput.js'

function fakeOutputService(): {
  service: IOutputService
  channels: Map<string, IOutputChannel>
  activeChannel: string | undefined
  setActiveChannel: ReturnType<typeof vi.fn>
} {
  const channels = new Map<string, IOutputChannel>()
  const state = { activeChannel: undefined as string | undefined }
  const setActiveChannel = vi.fn((name: string) => {
    state.activeChannel = name
  })
  const service = {
    createChannel(name: string): IOutputChannel {
      const channel = { name } as unknown as IOutputChannel
      channels.set(name, channel)
      return channel
    },
    setActiveChannel,
  } as unknown as IOutputService
  return {
    service,
    channels,
    get activeChannel() {
      return state.activeChannel
    },
    setActiveChannel,
  }
}

function fakeLayoutService(): {
  service: ILayoutService
  setVisible: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  const focus = vi.fn()
  const setVisible = vi.fn()
  const service = {
    setVisible,
    getPart: () => ({ focus }),
  } as unknown as ILayoutService
  return { service, setVisible, focus }
}

function fakeViewsService(): {
  service: IViewsService
  openViewContainer: ReturnType<typeof vi.fn>
} {
  const openViewContainer = vi.fn()
  const service = { openViewContainer } as unknown as IViewsService
  return { service, openViewContainer }
}

describe('MainThreadOutput', () => {
  it('$showOutputChannel reveals the output panel, not just switch the active channel', async () => {
    const output = fakeOutputService()
    const layout = fakeLayoutService()
    const views = fakeViewsService()
    const mt = new MainThreadOutput(output.service, layout.service, views.service)

    await mt.$registerOutputChannel(0, 'Git')
    await mt.$showOutputChannel(0)

    expect(output.setActiveChannel).toHaveBeenCalledWith('Git')
    // The bug: previously only setActiveChannel ran, so the panel never opened
    // when it was hidden. show() must also reveal the panel.
    expect(views.openViewContainer).toHaveBeenCalled()
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    expect(layout.focus).toHaveBeenCalled()
  })

  it('$showOutputChannel on an unknown handle does nothing', async () => {
    const output = fakeOutputService()
    const layout = fakeLayoutService()
    const views = fakeViewsService()
    const mt = new MainThreadOutput(output.service, layout.service, views.service)

    await mt.$showOutputChannel(42)

    expect(output.setActiveChannel).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
  })
})
