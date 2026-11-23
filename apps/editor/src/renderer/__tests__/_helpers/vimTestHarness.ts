/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared DI scaffolding for Vim-surface component tests (ActivityBar,
 *  PaneCompositeHeader, ...): a real ContextKeyService + ViewDescriptorService on
 *  a stub storage, a disposable bag, and view-container registration whose ids
 *  are unique per call so tests never collide in the global registries.
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest'
import {
  ContextKeyService,
  IContextKeyService,
  IViewDescriptorService,
  NullLogger,
  ServiceCollection,
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  type IDisposable,
  type ILoggerService,
  type IStorageService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { ViewDescriptorService } from '../../services/views/ViewDescriptorService.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

export interface VimTestServices {
  /** Pre-seeded with IContextKeyService + IViewDescriptorService; tests `set` the rest. */
  readonly services: ServiceCollection
  readonly contextKeyService: ContextKeyService
  readonly viewDescriptorService: ViewDescriptorService
  /** Own `d` until `dispose()`. */
  track<T extends IDisposable>(d: T): T
  /** Dispose everything tracked, newest first. Call from `afterEach`. */
  dispose(): void
}

export function makeVimTestServices(): VimTestServices {
  const disposables: IDisposable[] = []
  const track = <T extends IDisposable>(d: T): T => {
    disposables.push(d)
    return d
  }
  const contextKeyService = track(new ContextKeyService())
  const viewDescriptorService = track(
    new ViewDescriptorService(
      makeStorage(),
      { current: {} } as unknown as IWorkspaceService,
      contextKeyService,
      { createLogger: () => new NullLogger() } as unknown as ILoggerService,
    ),
  )
  const services = new ServiceCollection()
  services.set(IContextKeyService, contextKeyService)
  services.set(IViewDescriptorService, viewDescriptorService)
  return {
    services,
    contextKeyService,
    viewDescriptorService,
    track,
    dispose: () => {
      while (disposables.length > 0) disposables.pop()?.dispose()
    },
  }
}

export interface RegisterTestContainersOptions {
  readonly location?: ViewContainerLocation
  /** Namespace for the generated ids (a per-call sequence number is appended). */
  readonly idPrefix?: string
  readonly icon?: string | ((index: number) => string)
}

let idSeq = 0

/** Register `count` containers with one view each; returns the container ids in order. */
export function registerTestContainers(
  harness: Pick<VimTestServices, 'track'>,
  count: number,
  options: RegisterTestContainersOptions = {},
): string[] {
  const {
    location = ViewContainerLocation.SideBar,
    idPrefix = 'vim.test',
    icon = 'files',
  } = options
  const prefix = `${idPrefix}.${idSeq++}`
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${prefix}.${i}`
    ids.push(id)
    harness.track(
      ViewContainerRegistry.registerViewContainer({
        id,
        label: `Container ${i}`,
        icon: typeof icon === 'function' ? icon(i) : icon,
        order: i,
        location,
      }),
    )
    harness.track(
      ViewRegistry.registerView({
        id: `${id}.main`,
        name: `View ${i}`,
        containerId: id,
        componentKey: `${id}.main`,
        order: 1,
      }),
    )
  }
  return ids
}
