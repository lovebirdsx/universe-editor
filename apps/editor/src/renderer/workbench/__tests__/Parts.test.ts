import { describe, expect, it, vi } from 'vitest'
import {
  ILayoutService,
  InstantiationService,
  IStorageService,
  PartId,
  ServiceCollection,
} from '@universe-editor/platform'
import { LayoutService } from '../layout/LayoutService.js'
import {
  ActivityBarPart,
  ALL_PART_CTORS,
  EditorAreaPart,
  PanelPart,
  SecondarySideBarPart,
  SideBarPart,
  StatusBarPart,
} from '../parts/index.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as IStorageService
}

function makeContainer() {
  const services = new ServiceCollection()
  services.set(IStorageService, makeStorage())
  const instantiation = new InstantiationService(services, true)
  const layoutService = instantiation.createInstance(LayoutService)
  services.set(ILayoutService, layoutService)
  return { instantiation, layoutService }
}

describe('Concrete workbench Parts', () => {
  it('SideBarPart registers itself with role "complementary"', () => {
    const { instantiation, layoutService } = makeContainer()
    const part = instantiation.createInstance(SideBarPart)
    expect(layoutService.getPart(PartId.SideBar)).toBe(part)
    expect(part.role).toBe('complementary')
    expect(part.id).toBe(PartId.SideBar)
  })

  it('all six Parts register under distinct PartIds', () => {
    const { instantiation, layoutService } = makeContainer()
    for (const Ctor of ALL_PART_CTORS) {
      instantiation.createInstance(Ctor)
    }
    expect(layoutService.getParts()).toHaveLength(6)
    expect(layoutService.getPart(PartId.ActivityBar)).toBeInstanceOf(ActivityBarPart)
    expect(layoutService.getPart(PartId.SideBar)).toBeInstanceOf(SideBarPart)
    expect(layoutService.getPart(PartId.SecondarySideBar)).toBeInstanceOf(SecondarySideBarPart)
    expect(layoutService.getPart(PartId.EditorArea)).toBeInstanceOf(EditorAreaPart)
    expect(layoutService.getPart(PartId.Panel)).toBeInstanceOf(PanelPart)
    expect(layoutService.getPart(PartId.StatusBar)).toBeInstanceOf(StatusBarPart)
  })

  it('Part.dispose() removes it from the registry', () => {
    const { instantiation, layoutService } = makeContainer()
    const part = instantiation.createInstance(PanelPart)
    expect(layoutService.getPart(PartId.Panel)).toBe(part)
    part.dispose()
    expect(layoutService.getPart(PartId.Panel)).toBeUndefined()
  })

  it('Part.visible mirrors the LayoutService visibility', () => {
    const { instantiation, layoutService } = makeContainer()
    const sideBar = instantiation.createInstance(SideBarPart)
    expect(sideBar.visible.get()).toBe(true)
    layoutService.setVisible(PartId.SideBar, false)
    expect(sideBar.visible.get()).toBe(false)
  })

  it('focus() does not throw before the container is attached', () => {
    const { instantiation } = makeContainer()
    const part = instantiation.createInstance(StatusBarPart)
    expect(() => part.focus()).not.toThrow()
  })
})
