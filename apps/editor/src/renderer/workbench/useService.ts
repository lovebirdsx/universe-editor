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
import type { IDisposable } from '@universe-editor/platform'
import {
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
 * Minimal contract a service must expose to be consumed via useSnapshot.
 * Matches IEditorService / IStatusBarService / ILayoutService etc.
 */
export interface ISubscribableService<TState> {
  getSnapshot(): TState
  subscribe(listener: () => void): IDisposable
}

/**
 * Subscribe to a service via useSyncExternalStore.
 *
 * The selector picks the slice the component cares about. `isEqual` (default
 * `Object.is`) decides whether the new selected value should trigger a rerender;
 * pass `shallow` from `./shallow.js` when the selector returns an object.
 *
 * Caches the last (state, selected) pair so that even when the underlying state
 * object hasn't changed, we return the exact same selected reference — required
 * for uSES stability in React 19 concurrent rendering.
 */
export function useSnapshot<TState, TSelected>(
  service: ISubscribableService<TState>,
  selector: (state: TState) => TSelected,
  isEqual: (a: TSelected, b: TSelected) => boolean = Object.is,
): TSelected {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const d = service.subscribe(onChange)
      return () => d.dispose()
    },
    [service],
  )

  const lastRef = useRef<{ state: TState; selected: TSelected } | null>(null)

  const getSelectedSnapshot = useCallback((): TSelected => {
    const state = service.getSnapshot()
    const last = lastRef.current

    if (last !== null && last.state === state) {
      return last.selected
    }

    const selected = selector(state)
    if (last !== null && isEqual(last.selected, selected)) {
      // Same selected slice — keep the old reference so React sees no change.
      lastRef.current = { state, selected: last.selected }
      return last.selected
    }

    lastRef.current = { state, selected }
    return selected
  }, [service, selector, isEqual])

  return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot)
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
