/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useContextMenuMemory: the memory cache is keyed by the IStorageService
 *  instance — one cache per container, so every menu in a workbench shares it,
 *  while test suites binding a fresh storage stub never see each other's
 *  recorded picks. Persistence round-trips and the tag-less fallback bucket
 *  live in the workbench-ui ListMenu/ContextMenu tests.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import {
  Event,
  IStorageService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { useContextMenuMemory } from '../useContextMenuMemory.js'

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: Event.None,
  } as unknown as IStorageService
}

function makeContainer(storage: IStorageService) {
  const services = new ServiceCollection()
  services.set(IStorageService, storage)
  return services
}

function wrapperWith(services: ServiceCollection) {
  const inst = new InstantiationService(services)
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
  }
}

describe('useContextMenuMemory', () => {
  it('returns undefined when no IStorageService is bound', () => {
    const { result } = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(new ServiceCollection()),
    })
    expect(result.current).toBeUndefined()
  })

  it('shares one cache per storage service', () => {
    const storage = makeStorage()
    const first = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(makeContainer(storage)),
    })
    const second = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(makeContainer(storage)),
    })
    expect(second.result.current).toBe(first.result.current)

    first.result.current?.set('menu', undefined, 'itemId')
    expect(second.result.current?.get('menu', undefined)).toBe('itemId')
  })

  it('isolates caches across storage services (no cross-suite leaks)', () => {
    const first = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(makeContainer(makeStorage())),
    })
    first.result.current?.set('menu', undefined, 'itemFromAnotherSuite')

    const second = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(makeContainer(makeStorage())),
    })
    expect(second.result.current).not.toBe(first.result.current)
    expect(second.result.current?.get('menu', undefined)).toBeUndefined()
  })

  it('records a pick and serves it back synchronously within one instance', () => {
    const { result } = renderHook(() => useContextMenuMemory(), {
      wrapper: wrapperWith(makeContainer(makeStorage())),
    })
    const memory = result.current
    expect(memory).toBeDefined()
    memory?.set('menu', 'tag', 'itemId')
    expect(memory?.get('menu', 'tag')).toBe('itemId')
  })
})
