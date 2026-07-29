/*---------------------------------------------------------------------------------------------
 *  Tests for LogOutputView: per-channel model switching, view-state save, and
 *  auto-scroll initialization. Asserts on the service-layer models (the Monaco
 *  stub editor only mirrors a textarea for prompt-style tests).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  IOutputService,
  InstantiationService,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import {
  IOutputModelService,
  OutputModelService,
} from '../../../../services/output/OutputModelService.js'
import { ServicesContext } from '../../../useService.js'
import { LogOutputView, isScrolledToBottom } from '../LogOutputView.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function setup() {
  const output = new OutputService(makeStorage())
  const models = new OutputModelService(output, makeStorage())
  const services = new ServiceCollection()
  services.set(IOutputService, output)
  services.set(IOutputModelService, models)
  const instantiation = new InstantiationService(services)
  render(
    <ServicesContext.Provider value={instantiation}>
      <LogOutputView fontSize={13} fontFamily="monospace" />
    </ServicesContext.Provider>,
  )
  return { output, models }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('LogOutputView', () => {
  it('acquires and seeds the model of the active channel', async () => {
    const { output, models } = setup()
    const ch = output.createChannel('main')
    ch.append('hello\n')
    await settle()
    expect(models.peekModel('main')?.getValue()).toBe('hello\n')
  })

  it('mirrors later flushes into the mounted model', async () => {
    const { output, models } = setup()
    const ch = output.createChannel('main')
    ch.append('hello\n')
    await settle()

    ch.appendLine('world')
    await settle()
    expect(models.peekModel('main')?.getValue()).toBe('hello\nworld\n')
  })

  it('saves the previous channel view state when switching channels', async () => {
    const { output, models } = setup()
    const saveSpy = vi.spyOn(models, 'saveViewState')
    output.createChannel('main').append('x')
    await settle()

    output.createChannel('debug')
    output.setActiveChannel('debug')
    await settle()

    expect(saveSpy).toHaveBeenCalledWith('main', null)
  })

  it('re-acquires a distinct model per channel', async () => {
    const { output, models } = setup()
    output.createChannel('main').append('m\n')
    output.createChannel('debug').append('d\n')
    await settle()

    output.setActiveChannel('debug')
    await settle()
    expect(models.peekModel('debug')?.getValue()).toBe('d\n')
    expect(models.peekModel('main')).toBeDefined()
    expect(models.peekModel('debug')).not.toBe(models.peekModel('main'))
  })

  it('initializes autoScroll from the restored position (stub reports bottom)', async () => {
    const { output, models } = setup()
    models.setAutoScroll(false)
    output.createChannel('main').append('x')
    await settle()
    expect(models.autoScroll.get()).toBe(true)
  })
})

describe('isScrolledToBottom', () => {
  const fakeEditor = (scrollTop: number, scrollHeight: number, height: number) =>
    ({
      getScrollTop: () => scrollTop,
      getScrollHeight: () => scrollHeight,
      getLayoutInfo: () => ({ height }),
    }) as never

  it('is true within the threshold and false above it', () => {
    expect(isScrolledToBottom(fakeEditor(200, 400, 200))).toBe(true)
    expect(isScrolledToBottom(fakeEditor(181, 400, 200))).toBe(true)
    expect(isScrolledToBottom(fakeEditor(100, 400, 200))).toBe(false)
  })
})
