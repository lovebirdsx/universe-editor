/**
 * `react` shim for trusted-view component builds: every export is served from
 * the React instance the renderer installed under
 * {@link TRUSTED_VIEWS_RUNTIME_KEY}. Extension builds alias `react` here so the
 * component and the editor share one React (hooks require that).
 */
import { getTrustedViewsRuntime } from './runtime.js'

const runtime = getTrustedViewsRuntime()
const ReactInstance: typeof import('react') = runtime.React

export default ReactInstance

export const {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = ReactInstance
