/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  React bridge between the DI container and workbench components.
 *--------------------------------------------------------------------------------------------*/

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { Event } from '@universe-editor/platform'
import type { InstantiationService } from '@universe-editor/platform'
import type { ServiceIdentifier } from '@universe-editor/platform'

export const ServicesContext = createContext<InstantiationService | null>(null)

/** Retrieve a service instance from the DI container. */
export function useService<T>(id: ServiceIdentifier<T>): T {
  const container = useContext(ServicesContext)
  if (!container) throw new Error('useService must be used inside <Workbench>')
  return container.invokeFunction((accessor) => accessor.get(id))
}

/**
 * Subscribe to a platform Event and return the latest value as React state.
 * Re-renders only when the event fires.
 */
export function useEvent<T>(event: Event<T>, initialValue: T): T {
  const [value, setValue] = useState<T>(initialValue)
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    const disposable = event((newValue: T) => {
      if (newValue !== valueRef.current) {
        setValue(newValue)
      }
    })
    return () => disposable.dispose()
  }, [event])

  return value
}

/**
 * Subscribe to a platform Event and compute a derived value.
 * Useful when the raw event payload needs transformation.
 */
export function useDerived<TEvent, TState>(
  event: Event<TEvent>,
  compute: (payload: TEvent) => TState,
  initialValue: TState,
): TState {
  const [value, setValue] = useState<TState>(initialValue)
  const computeRef = useRef(compute)
  computeRef.current = compute

  useEffect(() => {
    const disposable = event((payload: TEvent) => {
      setValue(computeRef.current(payload))
    })
    return () => disposable.dispose()
  }, [event])

  return value
}
