/*---------------------------------------------------------------------------------------------
 *  Tests for QuickInputService — quickInputVisible ContextKey lifecycle and
 *  onDidChangeState emitter. The ContextKey is what gates which ESC keybinding
 *  the global handler picks, so its correctness across show / accept / hide /
 *  input commit is load-bearing for the ESC routing refactor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  IContextKeyService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { QuickInputService, type QuickPickState } from '../QuickInputService.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  private readonly _map = new Map<string, unknown>()
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this._map.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this._map.set(key, value)
  }
}

function createService(): {
  svc: QuickInputService
  ctx: ContextKeyService
} {
  const ctx = new ContextKeyService()
  const services = new ServiceCollection()
  services.set(IStorageService, new FakeStorage())
  services.set(IContextKeyService, ctx)
  const instantiation = new InstantiationService(services)
  const svc = instantiation.createInstance(QuickInputService)
  return { svc, ctx }
}

describe('QuickInputService — quickInputVisible ContextKey', () => {
  let svc: QuickInputService
  let ctx: ContextKeyService

  beforeEach(() => {
    ;({ svc, ctx } = createService())
  })

  afterEach(() => {
    svc.hide()
  })

  it('initial value is false', () => {
    expect(ctx.get('quickInputVisible')).toBe(false)
  })

  it('pick() shows panel → true; accept → false', async () => {
    let acceptFn: ((items: { id: string; label: string }[]) => void) | undefined
    const captureAcceptHandler = svc.onDidChangeState((state) => {
      if (state?.type === 'pick') acceptFn = state.onAccept
    })

    const promise = svc.pick([{ id: 'a', label: 'A' }])

    expect(ctx.get('quickInputVisible')).toBe(true)

    acceptFn?.([{ id: 'a', label: 'A' }])
    await promise

    expect(ctx.get('quickInputVisible')).toBe(false)
    captureAcceptHandler.dispose()
  })

  it('pick() shows panel → true; hide() → false', async () => {
    const promise = svc.pick([{ id: 'a', label: 'A' }])

    expect(ctx.get('quickInputVisible')).toBe(true)

    svc.hide()
    await promise

    expect(ctx.get('quickInputVisible')).toBe(false)
  })

  it('input() shows panel → true; commit → false', async () => {
    let inputFn: ((value: string) => void) | undefined
    const sub = svc.onDidChangeState((state) => {
      if (state?.type === 'input') inputFn = state.onInput
    })

    const promise = svc.input()

    expect(ctx.get('quickInputVisible')).toBe(true)

    inputFn?.('hello')
    await promise

    expect(ctx.get('quickInputVisible')).toBe(false)
    sub.dispose()
  })

  it('input() shows panel → true; hide() → false', async () => {
    const promise = svc.input()

    expect(ctx.get('quickInputVisible')).toBe(true)

    svc.hide()
    await promise

    expect(ctx.get('quickInputVisible')).toBe(false)
  })

  it('createQuickPick().show() → true; .hide() → false', () => {
    const qp = svc.createQuickPick()
    qp.show()
    expect(ctx.get('quickInputVisible')).toBe(true)

    qp.hide()
    expect(ctx.get('quickInputVisible')).toBe(false)

    qp.dispose()
  })

  it('hide() is a no-op when nothing is visible', () => {
    expect(ctx.get('quickInputVisible')).toBe(false)
    svc.hide()
    expect(ctx.get('quickInputVisible')).toBe(false)
  })

  it('hide() fires the onHide callback (createQuickPick path)', () => {
    const qp = svc.createQuickPick()
    const onHide = vi.fn()
    qp.onDidHide(onHide)

    qp.show()
    expect(onHide).not.toHaveBeenCalled()

    svc.hide()
    expect(onHide).toHaveBeenCalledOnce()

    qp.dispose()
  })

  it('hide() resolves an outstanding pick() with undefined', async () => {
    const promise = svc.pick([{ id: 'a', label: 'A' }])
    svc.hide()
    const result = await promise
    expect(result).toBeUndefined()
  })

  it('hide() resolves an outstanding input() with undefined', async () => {
    const promise = svc.input()
    svc.hide()
    const result = await promise
    expect(result).toBeUndefined()
  })
})

describe('QuickInputService — onDidChangeState', () => {
  it('fires on each state transition', () => {
    const { svc } = createService()
    const states: (QuickPickState | null)[] = []
    const sub = svc.onDidChangeState((s) => states.push(s))

    const qp = svc.createQuickPick()
    qp.show()
    qp.hide()

    expect(states).toHaveLength(2)
    expect(states[0]?.type).toBe('pick')
    expect(states[1]).toBeNull()

    qp.dispose()
    sub.dispose()
  })

  it('currentState reflects the latest state', () => {
    const { svc } = createService()
    expect(svc.currentState).toBeNull()

    const qp = svc.createQuickPick()
    qp.show()
    expect(svc.currentState?.type).toBe('pick')

    qp.hide()
    expect(svc.currentState).toBeNull()

    qp.dispose()
  })
})
