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
  markAsSingleton,
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
 * Same as useService but returns undefined when the identifier is not bound
 * (or invokeFunction throws). Use for soft dependencies — e.g. features that
 * are optional under unit tests.
 */
export function useOptionalService<T>(id: ServiceIdentifier<T>): T | undefined {
  const container = useContext(ServicesContext)
  const ref = useRef<{ id: ServiceIdentifier<T>; value: T | undefined } | null>(null)
  if (!container) return undefined
  if (ref.current === null || ref.current.id !== id) {
    let value: T | undefined
    try {
      value = container.invokeFunction((accessor) => accessor.get(id)) as T | undefined
    } catch {
      value = undefined
    }
    ref.current = { id, value }
  }
  return ref.current.value
}

/**
 * Subscribe to an IObservable and return its current value.
 * Re-renders the component whenever the observable changes.
 * Concurrent-safe: backed by useSyncExternalStore.
 */
export function useObservable<T>(obs: IObservable<T>): T {
  // Cache the snapshot in a ref. `derived` observables recompute on every `.get()`
  // while they have no active observer, returning a fresh object reference each
  // time — which violates useSyncExternalStore's contract that getSnapshot return
  // a stable reference between store changes (it would otherwise warn "getSnapshot
  // should be cached" and loop). We seed the ref on render and refresh it only from
  // the autorun subscription, during which the observable stays observed (cached).
  const cacheRef = useRef<{ obs: IObservable<T>; value: T } | null>(null)
  if (cacheRef.current === null || cacheRef.current.obs !== obs) {
    cacheRef.current = { obs, value: obs.get() }
  }

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let firstRun = true
      const d = markAsSingleton(
        autorun((r) => {
          const value = obs.read(r)
          // On the first run the subscription is just being established; keep the
          // render-phase snapshot reference unless the value actually changed in
          // the gap between render and subscribe.
          if (firstRun) {
            firstRun = false
            if (cacheRef.current && cacheRef.current.value === value) return
          }
          cacheRef.current = { obs, value }
          onStoreChange()
        }),
      )
      return () => d.dispose()
    },
    [obs],
  )

  const getSnapshot = useCallback(() => cacheRef.current!.value, [])

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
