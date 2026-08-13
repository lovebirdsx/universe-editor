import { afterEach, describe, expect, it } from 'vitest'
import { ViewContainerLocation, ViewContainerRegistry } from '../../workbench/viewRegistry.js'

function register(
  id: string,
  order: number,
  location: (typeof ViewContainerLocation)[keyof typeof ViewContainerLocation],
  contributed = false,
) {
  return ViewContainerRegistry.registerViewContainer({
    id,
    label: id,
    icon: 'files',
    order,
    location,
    ...(contributed ? { contributed: true } : {}),
  })
}

describe('ViewContainerRegistry', () => {
  const disposables: Array<{ dispose(): void }> = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  it('sorts containers by order within a location', () => {
    disposables.push(register('t.a', 2, ViewContainerLocation.SideBar))
    disposables.push(register('t.b', 1, ViewContainerLocation.SideBar))
    expect(
      ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar).map((c) => c.id),
    ).toEqual(['t.b', 't.a'])
  })

  it('keeps contributed containers after built-ins even when their order is lower', () => {
    // The old EXTENSION_CONTAINER_ORDER_BASE=100 offset made this an implicit
    // invariant ("built-ins always use tiny orders"); the tier flag makes it
    // structural, so neither side can leak across as it grows.
    disposables.push(register('t.ext', 0, ViewContainerLocation.SideBar, true))
    disposables.push(register('t.builtin', 5, ViewContainerLocation.SideBar))
    expect(
      ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar).map((c) => c.id),
    ).toEqual(['t.builtin', 't.ext'])
  })

  it('sorts within the contributed tier by order', () => {
    disposables.push(register('t.ext2', 101, ViewContainerLocation.SideBar, true))
    disposables.push(register('t.ext1', 100, ViewContainerLocation.SideBar, true))
    disposables.push(register('t.builtin', 6, ViewContainerLocation.SideBar))
    expect(
      ViewContainerRegistry.getViewContainers(ViewContainerLocation.SideBar).map((c) => c.id),
    ).toEqual(['t.builtin', 't.ext1', 't.ext2'])
  })

  it('tiers apply per location independently', () => {
    disposables.push(register('t.sidebar', 1, ViewContainerLocation.SideBar))
    disposables.push(register('t.panel.ext', 0, ViewContainerLocation.Panel, true))
    disposables.push(register('t.panel', 2, ViewContainerLocation.Panel))
    expect(
      ViewContainerRegistry.getViewContainers(ViewContainerLocation.Panel).map((c) => c.id),
    ).toEqual(['t.panel', 't.panel.ext'])
  })

  it('emits register/deregister events', () => {
    const seen: string[] = []
    const d1 = ViewContainerRegistry.onDidRegisterViewContainer((c) => seen.push(`+${c.id}`))
    const d2 = ViewContainerRegistry.onDidDeregisterViewContainer((c) => seen.push(`-${c.id}`))
    const d = register('t.evt', 1, ViewContainerLocation.SideBar)
    d.dispose()
    d1.dispose()
    d2.dispose()
    expect(seen).toEqual(['+t.evt', '-t.evt'])
  })
})
