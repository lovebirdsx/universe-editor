import { describe, expect, it, vi } from 'vitest'
import { type IPart, type IStorageService, PartId } from '@universe-editor/platform'
import { LayoutService } from '../layout/LayoutService.js'

function makeStorage(initial: unknown = undefined): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorageService
}

function makePart(id: PartId): IPart {
  return {
    id,
    role: 'region',
    isFocused: () => false,
    visible: { get: () => true } as unknown as IPart['visible'],
    onDidVisibilityChange: () => ({ dispose() {} }),
    getContainer: () => undefined,
    focus: () => {},
    dispose: () => {},
  }
}

describe('LayoutService — part registry', () => {
  it('registerPart stores the part and getPart can look it up', () => {
    const svc = new LayoutService(makeStorage())
    const sideBar = makePart(PartId.SideBar)

    svc.registerPart(sideBar)
    expect(svc.getPart(PartId.SideBar)).toBe(sideBar)
    expect(svc.getParts()).toEqual([sideBar])
  })

  it('returns undefined for unregistered ids', () => {
    const svc = new LayoutService(makeStorage())
    expect(svc.getPart(PartId.Panel)).toBeUndefined()
  })

  it('registerPart returns a disposable that removes the part', () => {
    const svc = new LayoutService(makeStorage())
    const editor = makePart(PartId.EditorArea)

    const d = svc.registerPart(editor)
    expect(svc.getPart(PartId.EditorArea)).toBe(editor)
    d.dispose()
    expect(svc.getPart(PartId.EditorArea)).toBeUndefined()
    expect(svc.getParts()).toEqual([])
  })

  it('throws when a different part is registered under an already-claimed id', () => {
    const svc = new LayoutService(makeStorage())
    const first = makePart(PartId.Panel)
    const second = makePart(PartId.Panel)
    svc.registerPart(first)
    expect(() => svc.registerPart(second)).toThrowError(/already registered/)
  })

  it('re-registering the same instance is a no-op', () => {
    const svc = new LayoutService(makeStorage())
    const p = makePart(PartId.StatusBar)
    svc.registerPart(p)
    expect(() => svc.registerPart(p)).not.toThrow()
    expect(svc.getParts()).toEqual([p])
  })

  it('onDidRegisterPart fires when a part is registered', () => {
    const svc = new LayoutService(makeStorage())
    const received: IPart[] = []
    svc.onDidRegisterPart((p) => received.push(p))
    const p = makePart(PartId.ActivityBar)
    svc.registerPart(p)
    expect(received).toEqual([p])
  })

  it('disposing then re-registering different parts under the same id works', () => {
    const svc = new LayoutService(makeStorage())
    const a = makePart(PartId.SideBar)
    const b = makePart(PartId.SideBar)
    const d = svc.registerPart(a)
    d.dispose()
    expect(() => svc.registerPart(b)).not.toThrow()
    expect(svc.getPart(PartId.SideBar)).toBe(b)
  })
})
