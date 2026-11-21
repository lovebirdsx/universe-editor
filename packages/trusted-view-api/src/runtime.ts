/**
 * Runtime injection point for trusted-view component modules.
 *
 * A `contributes.trustedViews` extension ships a browser ESM component. React
 * must not be bundled into that module: the renderer installs its own React and
 * JSX runtime on `globalThis` under this symbol before the first `import()`,
 * and the extension's build aliases `react` / `react/jsx-runtime` to the shims
 * exported by this package (`./react`, `./jsx-runtime`).
 */
import type * as ReactNs from 'react'

export const TRUSTED_VIEWS_RUNTIME_KEY = Symbol.for('universe-editor.trustedViews.runtime')

export type TrustedViewsJsxRuntime = Pick<
  typeof import('react/jsx-runtime'),
  'jsx' | 'jsxs' | 'Fragment'
>

/** The shared React instance the renderer injects for trusted-view modules. */
export interface TrustedViewsRuntime {
  readonly React: typeof ReactNs
  readonly jsxRuntime: TrustedViewsJsxRuntime
}

function isRuntime(value: unknown): value is TrustedViewsRuntime {
  if (typeof value !== 'object' || value === null) return false
  const runtime = value as Partial<TrustedViewsRuntime>
  const react = runtime.React as { createElement?: unknown } | undefined
  const jsxRuntime = runtime.jsxRuntime as { jsx?: unknown; jsxs?: unknown } | undefined
  return (
    typeof react?.createElement === 'function' &&
    typeof jsxRuntime?.jsx === 'function' &&
    typeof jsxRuntime?.jsxs === 'function'
  )
}

/**
 * Read the runtime the renderer injected. Throws when the module is imported
 * outside the renderer (or before the renderer installed the runtime) — a
 * silent fallback would let an extension bundle its own React and break hooks.
 */
export function getTrustedViewsRuntime(): TrustedViewsRuntime {
  const runtime = (globalThis as unknown as Record<symbol, unknown>)[TRUSTED_VIEWS_RUNTIME_KEY]
  if (!isRuntime(runtime)) {
    throw new Error(
      'trusted-view runtime is not installed; import this shim from a contributes.trustedViews component loaded by the editor',
    )
  }
  return runtime
}

/** Install (or replace) the shared runtime. Called once by the renderer. */
export function setTrustedViewsRuntime(runtime: TrustedViewsRuntime): void {
  ;(globalThis as unknown as Record<symbol, unknown>)[TRUSTED_VIEWS_RUNTIME_KEY] = runtime
}
