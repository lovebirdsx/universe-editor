/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/window/windowsJumpList.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, URI, type IRecentWorkspace } from '@universe-editor/platform'

type JumpListCategory = {
  type: string
  name?: string
  items?: Array<{ title?: string; args?: string; program?: string }>
}

const setJumpList = vi.fn((_list: JumpListCategory[]) => 'ok' as const)
vi.mock('electron', () => ({
  app: {
    setJumpList: (list: JumpListCategory[]) => setJumpList(list),
  },
}))

const { WindowsJumpList } = await import('../windowsJumpList.js')

function makeRecent(recent: IRecentWorkspace[] = []) {
  const emitter = new Emitter<readonly IRecentWorkspace[]>()
  return {
    onDidChangeRecent: emitter.event,
    getRecent: async () => recent,
    fire: () => emitter.fire(recent),
  }
}

const originalPlatform = process.platform
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('WindowsJumpList', () => {
  beforeEach(() => {
    setJumpList.mockClear()
    setPlatform('win32')
  })
  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('does nothing on non-Windows platforms', async () => {
    setPlatform('darwin')
    const jl = new WindowsJumpList(makeRecent() as never)
    await Promise.resolve()
    expect(setJumpList).not.toHaveBeenCalled()
    jl.dispose()
  })

  it('always includes the New Window task with empty args', async () => {
    const jl = new WindowsJumpList(makeRecent() as never)
    await vi.waitFor(() => expect(setJumpList).toHaveBeenCalled())
    const list = setJumpList.mock.calls[0]![0]
    const tasks = list.find((c) => c.type === 'tasks')
    expect(tasks?.items?.[0]?.args).toBe('')
    // No recent folders → no custom category.
    expect(list.some((c) => c.type === 'custom')).toBe(false)
    jl.dispose()
  })

  it('adds a Recent Folders category with quoted fsPath args', async () => {
    const recent: IRecentWorkspace[] = [
      { folder: URI.file('C:\\work\\proj'), name: 'proj', lastOpened: 2 },
      { folder: URI.file('C:\\work\\other'), name: 'other', lastOpened: 1 },
    ]
    const jl = new WindowsJumpList(makeRecent(recent) as never)
    await vi.waitFor(() => expect(setJumpList).toHaveBeenCalled())
    const list = setJumpList.mock.calls[0]![0]
    const custom = list.find((c) => c.type === 'custom')
    expect(custom?.items?.length).toBe(2)
    expect(custom?.items?.[0]?.title).toBe('proj')
    expect(custom?.items?.[0]?.args).toBe(`"${URI.file('C:\\work\\proj').fsPath}"`)
    jl.dispose()
  })

  it('refreshes the jump list when the recent list changes', async () => {
    const recent = makeRecent()
    const jl = new WindowsJumpList(recent as never)
    await vi.waitFor(() => expect(setJumpList).toHaveBeenCalledTimes(1))
    recent.fire()
    await vi.waitFor(() => expect(setJumpList).toHaveBeenCalledTimes(2))
    jl.dispose()
  })

  it('stops refreshing after dispose', async () => {
    const recent = makeRecent()
    const jl = new WindowsJumpList(recent as never)
    await vi.waitFor(() => expect(setJumpList).toHaveBeenCalledTimes(1))
    jl.dispose()
    recent.fire()
    await Promise.resolve()
    expect(setJumpList).toHaveBeenCalledTimes(1)
  })
})
