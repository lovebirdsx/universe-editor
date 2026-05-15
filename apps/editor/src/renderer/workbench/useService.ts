/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React bridge between the DI container and workbench components.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type DependencyList,
} from 'react'
import type { IDisposable, IObservable } from '@universe-editor/platform'
import {
  autorun,
  ICommandService,
  type InstantiationService,
  type ServiceIdentifier,
} from '@universe-editor/platform'

export const ServicesContext = createContext<InstantiationService | null>(null)

/** Retrieve a service instance from the DI container. Cached per component instance. */
export function useService<T>(id: ServiceIdentifier<T>): T {
  const container = useContext(ServicesContext)
  if (!container) throw new Error('useService must be used inside <Workbench>')

  // Services are singletons in the container; cache after first lookup to avoid
  // re-invoking invokeFunction on every render.
  const ref = useRef<{ id: ServiceIdentifier<T>; value: T } | null>(null)
  if (ref.current === null || ref.current.id !== id) {
    ref.current = { id, value: container.invokeFunction((accessor) => accessor.get(id)) }
  }
  return ref.current.value
}

/**
 * Subscribe to an IObservable and return its current value.
 * Re-renders the component whenever the observable changes.
 * Concurrent-safe: backed by useSyncExternalStore.
 */
export function useObservable<T>(obs: IObservable<T>): T {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let firstRun = true
      const d = autorun((r) => {
        obs.read(r)
        if (!firstRun) onStoreChange()
        firstRun = false
      })
      return () => d.dispose()
    },
    [obs],
  )

  const getSnapshot = useCallback(() => obs.get(), [obs])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Returns a stable function that executes a command via the ICommandService.
 * Encourages the View-only-triggers-commands pattern (plan §2 铁律 2).
 */
export function useExecuteCommand(): <R = void>(
  commandId: string,
  ...args: unknown[]
) => Promise<R | undefined> {
  const commandService = useService(ICommandService)
  return useCallback(
    <R = void>(commandId: string, ...args: unknown[]) =>
      commandService.executeCommand<R>(commandId, ...args),
    [commandService],
  )
}

/**
 * Construct a Disposable scoped to the component's lifetime. The factory is
 * memoized by `deps`; when deps change or the component unmounts, the previous
 * Disposable is disposed.
 */
export function useDisposable<T extends IDisposable>(factory: () => T, deps: DependencyList): T {
  const instance = useMemo(factory, deps)
  useEffect(() => () => instance.dispose(), [instance])
  return instance
}
