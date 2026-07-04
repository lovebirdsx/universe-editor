/*---------------------------------------------------------------------------------------------
 *  Tests for the Part base class.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../base/event.js'
import { IDisposable, toDisposable } from '../../base/lifecycle.js'
import { ISettableObservable, observableValue, transaction } from '../../base/observable/index.js'
import { ILayoutService, LayoutSizes, PartId } from '../../workbench/layoutService.js'
import { IPart, Part } from '../../workbench/part.js'

/**
 * Minimal in-memory `ILayoutService` for unit testing Parts in isolation.
 * Backed by `observableValue` for `visible / sizes` to match the renderer impl.
 */
class StubLayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined
  readonly visible: ISettableObservable<Readonly<Record<PartId, boolean>>>
  readonly sizes: ISettableObservable<Readonly<LayoutSizes>>
  readonly panelMaximized: ISettableObservable<boolean>
  private readonly _parts = new Map<PartId, IPart>()
  private readonly _onDidRegisterPart = new Emitter<IPart>()
  readonly onDidRegisterPart = this._onDidRegisterPart.event

  constructor() {
    this.visible = observableValue('StubLayout.visible', {
      [PartId.ActivityBar]: true,
      [PartId.SideBar]: true,
      [PartId.SecondarySideBar]: false,
      [PartId.EditorArea]: true,
      [PartId.Panel]: true,
      [PartId.StatusBar]: true,
    })
    this.sizes = observableValue('StubLayout.sizes', {
      sidebar: 240,
      secondarySidebar: 300,
      panel: 200,
    })
    this.panelMaximized = observableValue('StubLayout.panelMaximized', false)
  }

  getVisible(part: PartId): boolean {
    return this.visible.get()[part]
  }
  setVisible(part: PartId, visible: boolean): void {
    this.visible.set({ ...this.visible.get(), [part]: visible }, undefined)
  }
  toggleVisible(part: PartId): void {
    this.setVisible(part, !this.getVisible(part))
  }
  setSize(key: keyof LayoutSizes, value: number): void {
    this.sizes.set({ ...this.sizes.get(), [key]: value }, undefined)
  }
  setPanelMaximized(maximized: boolean): void {
    this.panelMaximized.set(maximized, undefined)
  }
  togglePanelMaximized(): void {
    this.setPanelMaximized(!this.panelMaximized.get())
  }
  async load() {}
  loadDefaults() {}
  async reconcileFromStorage() {}
  async save() {}

  registerPart(part: IPart): IDisposable {
    this._parts.set(part.id, part)
    this._onDidRegisterPart.fire(part)
    return toDisposable(() => {
      if (this._parts.get(part.id) === part) this._parts.delete(part.id)
    })
  }
  getPart<T extends IPart = IPart>(id: PartId): T | undefined {
    return this._parts.get(id) as T | undefined
  }
  getParts(): readonly IPart[] {
    return [...this._parts.values()]
  }
  async focusPart(): Promise<boolean> {
    return false
  }
  async focusView(): Promise<boolean> {
    return false
  }
}

class TestPart extends Part {
  constructor(id: PartId, role: string, layoutService: ILayoutService) {
    super(id, role, layoutService)
  }
}

describe('Part', () => {
  it('auto-registers with the layout service on construction', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    expect(ls.getPart(PartId.SideBar)).toBe(part)
    expect(ls.getParts()).toContain(part)
  })

  it('unregisters on dispose', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.Panel, 'region', ls)
    expect(ls.getPart(PartId.Panel)).toBe(part)
    part.dispose()
    expect(ls.getPart(PartId.Panel)).toBeUndefined()
  })

  it('exposes a visible observable mirroring the layout service', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.Panel, 'region', ls)
    expect(part.visible.get()).toBe(true)
    ls.setVisible(PartId.Panel, false)
    expect(part.visible.get()).toBe(false)
    ls.setVisible(PartId.Panel, true)
    expect(part.visible.get()).toBe(true)
    part.dispose()
  })

  it('fires onDidVisibilityChange only on actual transitions (not on initial subscribe)', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const received: boolean[] = []
    part.onDidVisibilityChange((v) => received.push(v))

    ls.setVisible(PartId.SideBar, true) // same value: no fire
    expect(received).toEqual([])

    ls.setVisible(PartId.SideBar, false)
    expect(received).toEqual([false])

    ls.setVisible(PartId.SideBar, true)
    expect(received).toEqual([false, true])
    part.dispose()
  })

  it('does not fire onDidVisibilityChange after dispose', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const spy = vi.fn()
    part.onDidVisibilityChange(spy)
    part.dispose()
    ls.setVisible(PartId.SideBar, false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('batches visibility changes within a transaction into a single fire', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.Panel, 'region', ls)
    const received: boolean[] = []
    part.onDidVisibilityChange((v) => received.push(v))

    transaction((tx) => {
      ls.visible.set({ ...ls.visible.get(), [PartId.Panel]: false }, tx)
      ls.visible.set({ ...ls.visible.get(), [PartId.Panel]: true }, tx)
      ls.visible.set({ ...ls.visible.get(), [PartId.Panel]: false }, tx)
    })
    // The autorun observes the final value only.
    expect(received).toEqual([false])
    part.dispose()
  })

  it('getContainer returns undefined before attach, the element after', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.EditorArea, 'main', ls)
    expect(part.getContainer()).toBeUndefined()
    const el = { focus: vi.fn() }
    ;(part as unknown as { _attachContainer(e: typeof el | null): void })._attachContainer(el)
    expect(part.getContainer()).toBe(el)
    ;(part as unknown as { _attachContainer(e: typeof el | null): void })._attachContainer(null)
    expect(part.getContainer()).toBeUndefined()
    part.dispose()
  })

  it('focus() dispatches to the focus target when set, otherwise the container', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const container = { focus: vi.fn() }
    const target = { focus: vi.fn() }
    const internal = part as unknown as {
      _attachContainer(e: { focus(): void } | null): void
      _setFocusTarget(e: { focus(): void } | null): void
    }
    internal._attachContainer(container)
    part.focus()
    expect(container.focus).toHaveBeenCalledOnce()
    internal._setFocusTarget(target)
    part.focus()
    expect(target.focus).toHaveBeenCalledOnce()
    part.dispose()
  })

  it('focus() is a no-op when no container is attached', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    expect(() => part.focus()).not.toThrow()
    part.dispose()
  })

  it('starts in unmounted state and transitions to mounted on attach', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    expect(part.mountState).toBe('unmounted')
    const internal = part as unknown as { _attachContainer(e: { focus(): void } | null): void }
    internal._attachContainer({ focus: vi.fn() })
    expect(part.mountState).toBe('mounted')
    internal._attachContainer(null)
    expect(part.mountState).toBe('unmounted')
    part.dispose()
  })

  it('fires onDidMount / onDidUnmount on attach / detach', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.Panel, 'region', ls)
    const mounted: number[] = []
    const unmounted: number[] = []
    part.onDidMount(() => mounted.push(1))
    part.onDidUnmount(() => unmounted.push(1))
    const internal = part as unknown as { _attachContainer(e: { focus(): void } | null): void }
    const el = { focus: vi.fn() }
    internal._attachContainer(el)
    internal._attachContainer(el) // same element, mounted state unchanged
    expect(mounted).toHaveLength(1)
    internal._attachContainer(null)
    expect(unmounted).toHaveLength(1)
    part.dispose()
  })

  it('whenMounted() resolves immediately if mounted, otherwise on next mount', async () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const internal = part as unknown as { _attachContainer(e: { focus(): void } | null): void }

    const p = part.whenMounted(1000)
    internal._attachContainer({ focus: vi.fn() })
    await expect(p).resolves.toBeUndefined()

    await expect(part.whenMounted(1000)).resolves.toBeUndefined()
    part.dispose()
  })

  it('whenMounted() rejects on timeout', async () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    await expect(part.whenMounted(10)).rejects.toThrow(/did not mount/)
    part.dispose()
  })

  it('focus() before mount queues; on attach the focus target gets called', async () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const target = { focus: vi.fn() }
    part.focus()
    expect(part.hasPendingFocus()).toBe(true)
    expect(target.focus).not.toHaveBeenCalled()

    const internal = part as unknown as { _attachContainer(e: { focus(): void } | null): void }
    internal._attachContainer(target)
    // The pending focus is flushed via queueMicrotask.
    await new Promise<void>((r) => queueMicrotask(r))
    expect(target.focus).toHaveBeenCalledOnce()
    expect(part.hasPendingFocus()).toBe(false)
    part.dispose()
  })

  it('focus() while mounted fires onDidFocus immediately', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const internal = part as unknown as {
      _attachContainer(e: { focus(): void } | null): void
    }
    internal._attachContainer({ focus: vi.fn() })
    const spy = vi.fn()
    part.onDidFocus(spy)
    part.focus()
    expect(spy).toHaveBeenCalledOnce()
    part.dispose()
  })

  it('_notifyFocusChange fires onDidFocus / onDidBlur', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.SideBar, 'complementary', ls)
    const focused = vi.fn()
    const blurred = vi.fn()
    part.onDidFocus(focused)
    part.onDidBlur(blurred)
    ;(part as unknown as { _notifyFocusChange(f: boolean): void })._notifyFocusChange(true)
    expect(focused).toHaveBeenCalledOnce()
    ;(part as unknown as { _notifyFocusChange(f: boolean): void })._notifyFocusChange(false)
    expect(blurred).toHaveBeenCalledOnce()
    part.dispose()
  })

  it('dispose fires onDidUnmount if currently mounted', () => {
    const ls = new StubLayoutService()
    const part = new TestPart(PartId.Panel, 'region', ls)
    const internal = part as unknown as { _attachContainer(e: { focus(): void } | null): void }
    internal._attachContainer({ focus: vi.fn() })
    const spy = vi.fn()
    part.onDidUnmount(spy)
    part.dispose()
    expect(spy).toHaveBeenCalledOnce()
  })
})
