/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  releaseInputMethod,
  requestInputMethod,
  resetVimInputMethodForTests,
} from '../vimInputMethod.js'

function createService(overrides: { switchToEnglish?: () => Promise<boolean> } = {}) {
  return {
    _serviceBrand: undefined,
    switchToEnglish: vi.fn(overrides.switchToEnglish ?? (async () => true)),
    restore: vi.fn(async () => undefined),
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('vimInputMethod', () => {
  beforeEach(() => resetVimInputMethodForTests())
  afterEach(() => resetVimInputMethodForTests())

  it('only forwards transitions, never repeats', async () => {
    const service = createService()
    const owner = {}
    requestInputMethod(owner, service, 'english')
    requestInputMethod(owner, service, 'english')
    await flush()
    expect(service.switchToEnglish).toHaveBeenCalledTimes(1)
    requestInputMethod(owner, service, 'native')
    requestInputMethod(owner, service, 'native')
    await flush()
    expect(service.restore).toHaveBeenCalledTimes(1)
  })

  it('serializes a fast english -> native pair in order', async () => {
    const order: string[] = []
    const service = {
      _serviceBrand: undefined,
      switchToEnglish: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('english')
        return true
      }),
      restore: vi.fn(async () => {
        order.push('native')
      }),
    }
    const owner = {}
    requestInputMethod(owner, service, 'english')
    requestInputMethod(owner, service, 'native')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['english', 'native'])
  })

  it('retries after main refuses the switch', async () => {
    const service = createService({ switchToEnglish: async () => false })
    const owner = {}
    requestInputMethod(owner, service, 'english')
    await flush()
    requestInputMethod(owner, service, 'english')
    await flush()
    expect(service.switchToEnglish).toHaveBeenCalledTimes(2)
  })

  it('logs and falls back to native when the IPC call throws', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const service = createService({
      switchToEnglish: async () => {
        throw new Error('ipc down')
      },
    })
    const owner = {}
    requestInputMethod(owner, service, 'english')
    await flush()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('[vim]'), expect.any(Error))
    requestInputMethod(owner, service, 'english')
    await flush()
    expect(service.switchToEnglish).toHaveBeenCalledTimes(2)
    debug.mockRestore()
  })

  it('releases English only for the owner that holds it', async () => {
    const service = createService()
    const focused = {}
    const background = {}
    requestInputMethod(focused, service, 'english')
    await flush()
    releaseInputMethod(background, service)
    await flush()
    expect(service.restore).not.toHaveBeenCalled()
    releaseInputMethod(focused, service)
    await flush()
    expect(service.restore).toHaveBeenCalledTimes(1)
  })

  it('ignores a native request from a background owner while another holds English', async () => {
    const service = createService()
    const focused = {}
    const background = {}
    requestInputMethod(focused, service, 'english')
    await flush()
    // The background controller reacts to a config change and asks for native.
    requestInputMethod(background, service, 'native')
    await flush()
    expect(service.restore).not.toHaveBeenCalled()
    // The focused owner can still hand English back.
    requestInputMethod(focused, service, 'native')
    await flush()
    expect(service.restore).toHaveBeenCalledTimes(1)
  })

  it('lets a newly focused owner take over English without a second switch', async () => {
    const service = createService()
    const first = {}
    const second = {}
    requestInputMethod(first, service, 'english')
    requestInputMethod(second, service, 'english')
    await flush()
    expect(service.switchToEnglish).toHaveBeenCalledTimes(1)
    // The previous owner can no longer cancel English under the new one.
    releaseInputMethod(first, service)
    await flush()
    expect(service.restore).not.toHaveBeenCalled()
    releaseInputMethod(second, service)
    await flush()
    expect(service.restore).toHaveBeenCalledTimes(1)
  })

  it('does not hold English for an owner whose switch was refused', async () => {
    const service = createService({ switchToEnglish: async () => false })
    const owner = {}
    const other = {}
    requestInputMethod(owner, service, 'english')
    await flush()
    // Ownership was dropped with the failed switch, so another owner may act freely.
    requestInputMethod(other, service, 'native')
    await flush()
    expect(service.restore).toHaveBeenCalledTimes(0)
    requestInputMethod(other, service, 'english')
    await flush()
    expect(service.switchToEnglish).toHaveBeenCalledTimes(2)
  })
})
