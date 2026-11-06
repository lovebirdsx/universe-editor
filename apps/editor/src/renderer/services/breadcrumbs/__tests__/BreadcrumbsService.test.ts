/*---------------------------------------------------------------------------------------------
 *  Tests for services/breadcrumbs/BreadcrumbsService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ContextKeyService,
  DisposableStore,
  Emitter,
  type IEditorGroup,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import { BreadcrumbsService, type IBreadcrumbsController } from '../BreadcrumbsService.js'

function controller(groupId: number): IBreadcrumbsController {
  return {
    groupId,
    focusLast: vi.fn(),
    focusAndSelectLast: vi.fn(),
    focusNext: vi.fn(),
    focusPrevious: vi.fn(),
    selectFocused: vi.fn(),
    revealFocused: vi.fn(),
    selectEditor: vi.fn(),
    dismissPicker: vi.fn(),
  }
}

function makeGroups(initial: IEditorGroup) {
  let activeGroup = initial
  const onDidActiveGroupChange = new Emitter<IEditorGroup>()
  const onDidRemoveGroup = new Emitter<IEditorGroup>()
  const service = {
    _serviceBrand: undefined,
    get activeGroup() {
      return activeGroup
    },
    onDidActiveGroupChange: onDidActiveGroupChange.event,
    onDidRemoveGroup: onDidRemoveGroup.event,
  } as unknown as IEditorGroupsService
  const switchTo = (group: IEditorGroup): void => {
    activeGroup = group
    onDidActiveGroupChange.fire(group)
  }
  return {
    service,
    switchTo,
    remove: (group: IEditorGroup) => onDidRemoveGroup.fire(group),
  }
}

describe('BreadcrumbsService', () => {
  const group1 = { id: 1 } as IEditorGroup
  const group2 = { id: 2 } as IEditorGroup

  it('publishes possible/visible for the active group only', () => {
    const groups = makeGroups(group1)
    const contextKeys = new ContextKeyService()
    const service = new BreadcrumbsService(groups.service, contextKeys)
    const store = new DisposableStore()

    expect(contextKeys.get('breadcrumbsPossible')).toBe(false)

    store.add(service.register(group1.id, controller(group1.id)))
    expect(contextKeys.get('breadcrumbsPossible')).toBe(true)
    expect(contextKeys.get('breadcrumbsVisible')).toBe(true)

    groups.switchTo(group2)
    expect(contextKeys.get('breadcrumbsPossible')).toBe(false)

    store.add(service.register(group2.id, controller(group2.id)))
    expect(contextKeys.get('breadcrumbsPossible')).toBe(true)
    store.dispose()
    service.dispose()
  })

  it('dismisses the active controller when the active group changes', () => {
    const groups = makeGroups(group1)
    const contextKeys = new ContextKeyService()
    const service = new BreadcrumbsService(groups.service, contextKeys)
    const first = controller(group1.id)
    const store = new DisposableStore()
    store.add(service.register(group1.id, first))
    service.activate(first)

    groups.switchTo(group2)

    expect(first.dismissPicker).toHaveBeenCalledTimes(1)
    store.dispose()
    service.dispose()
  })

  it('tracks the active breadcrumb controller', () => {
    const groups = makeGroups(group1)
    const contextKeys = new ContextKeyService()
    const service = new BreadcrumbsService(groups.service, contextKeys)
    const first = controller(group1.id)
    const store = new DisposableStore()
    store.add(service.register(group1.id, first))

    expect(service.activeController).toBeUndefined()
    service.activate(first)
    expect(service.activeController).toBe(first)
    expect(contextKeys.get('breadcrumbsActive')).toBe(true)
    service.deactivate(controller(group1.id))
    expect(contextKeys.get('breadcrumbsActive')).toBe(true)
    service.deactivate(first)
    expect(service.activeController).toBeUndefined()
    expect(contextKeys.get('breadcrumbsActive')).toBe(false)

    store.dispose()
    service.dispose()
  })

  it('cleans up when a group is removed', () => {
    const groups = makeGroups(group1)
    const contextKeys = new ContextKeyService()
    const service = new BreadcrumbsService(groups.service, contextKeys)
    const store = new DisposableStore()
    store.add(service.register(group1.id, controller(group1.id)))
    service.activate(service.get(group1.id)!)

    groups.remove(group1)

    expect(service.get(group1.id)).toBeUndefined()
    expect(contextKeys.get('breadcrumbsPossible')).toBe(false)
    expect(contextKeys.get('breadcrumbsActive')).toBe(false)
    store.dispose()
    service.dispose()
  })

  it('is identity safe when a group re-registers (StrictMode double mount)', () => {
    const groups = makeGroups(group1)
    const contextKeys = new ContextKeyService()
    const service = new BreadcrumbsService(groups.service, contextKeys)
    const first = controller(group1.id)
    const second = controller(group1.id)

    const firstRegistration = service.register(group1.id, first)
    const secondRegistration = service.register(group1.id, second)
    firstRegistration.dispose()

    expect(service.get(group1.id)).toBe(second)

    secondRegistration.dispose()
    expect(service.get(group1.id)).toBeUndefined()
    expect(contextKeys.get('breadcrumbsPossible')).toBe(false)
    service.dispose()
  })

  it('returns undefined for an unknown or missing group id', () => {
    const groups = makeGroups(group1)
    const service = new BreadcrumbsService(groups.service, new ContextKeyService())
    expect(service.get(undefined)).toBeUndefined()
    expect(service.get(99)).toBeUndefined()
    service.dispose()
  })
})
