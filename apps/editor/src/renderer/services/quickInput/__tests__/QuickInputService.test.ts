/*---------------------------------------------------------------------------------------------
 *  Tests for QuickInputService — quickInputVisible ContextKey lifecycle and
 *  onDidChangeState emitter. The ContextKey is what gates which ESC keybinding
 *  the global handler picks, so its correctness across show / accept / hide /
 *  input commit is load-bearing for the ESC routing refactor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  Event,
  IContextKeyService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { QuickInputService, type QuickPickState } from '../QuickInputService.js'

class FakeStorage implements IStorageService {
  declare readonly _serviceBrand: undefined
  private readonly _map = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this._map.get(key) as T | undefined
  }
  async set(key: string, value: unknown): Promise<void> {
    this._map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this._map.delete(key)
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

describe('QuickInputService — focus restoration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('restores the previously focused element when hide() closes the panel', async () => {
    const { svc } = createService()
    const button = document.createElement('button')
    const input = document.createElement('input')
    document.body.append(button, input)

    button.focus()
    const promise = svc.pick([{ id: 'a', label: 'A' }])

    input.focus()
    svc.hide()
    await promise
    await vi.runAllTimersAsync()

    expect(document.activeElement).toBe(button)
  })

  it('skips restoration when the previously focused element was removed', async () => {
    const { svc } = createService()
    const button = document.createElement('button')
    const input = document.createElement('input')
    document.body.append(button, input)

    button.focus()
    const promise = svc.pick([{ id: 'a', label: 'A' }])

    input.focus()
    button.remove()
    svc.hide()
    await promise

    await vi.runAllTimersAsync()
    expect(document.activeElement).not.toBe(button)
  })

  it('does not steal focus from a new pick that opened immediately after the previous one closed', async () => {
    // Chained QuickPick scenario: command palette closes (which schedules a
    // setTimeout to restore focus to the editor), then an Action2 synchronously
    // opens a second pick. The deferred restoreFocus must NOT fire while the
    // second pick is visible — otherwise it yanks focus away from the new
    // picker's input.
    const { svc } = createService()
    const editor = document.createElement('button')
    editor.setAttribute('data-role', 'editor')
    const pickerInput = document.createElement('input')
    pickerInput.setAttribute('data-role', 'picker')
    document.body.append(editor, pickerInput)

    // Editor has focus before the user opens the command palette.
    editor.focus()
    expect(document.activeElement).toBe(editor)

    // Capture the first pick's onAccept so we can simulate confirmation.
    let firstAccept: ((items: { id: string; label: string }[]) => void) | undefined
    const sub = svc.onDidChangeState((s) => {
      if (s?.type === 'pick' && firstAccept === undefined) firstAccept = s.onAccept
    })

    // Open first pick (the command palette).
    const firstPromise = svc.pick([{ id: 'cmd', label: 'Command' }])
    // The QuickPick rendering would focus its input here.
    pickerInput.focus()
    expect(document.activeElement).toBe(pickerInput)

    // User accepts an item in the command palette. The accept callback
    // synchronously closes the first pick (which schedules the focus restore
    // for the editor).
    firstAccept?.([{ id: 'cmd', label: 'Command' }])
    await firstPromise

    // Without yielding to macrotasks (setTimeout(0) hasn't fired yet), the
    // chained Action2 opens its own pick. In real code the panel's input is
    // reused across this state swap, so picker focus is conceptually retained.
    void svc.pick([{ id: 'session', label: 'Session' }])
    pickerInput.focus() // simulate the new pick's input being focused on render

    expect(svc.currentState).not.toBeNull()

    // Now let the deferred setTimeout(focus, 0) fire. With the bug, it
    // unconditionally calls `target.focus()` and the editor steals focus.
    // With the fix, it bails because a new pick is already visible.
    await vi.runAllTimersAsync()

    expect(document.activeElement).toBe(pickerInput)
    expect(document.activeElement).not.toBe(editor)
    sub.dispose()
  })
})
