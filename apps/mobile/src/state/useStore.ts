import { useSyncExternalStore } from 'react'
import type { ReadableStore } from './store.js'

export function useStore<T>(store: ReadableStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
