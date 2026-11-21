import { describe, expect, it } from 'vitest'
import {
  getTrustedViewsRuntime,
  setTrustedViewsRuntime,
  TRUSTED_VIEWS_RUNTIME_KEY,
  type TrustedViewsRuntime,
} from '../runtime.js'

const createElement = (): undefined => undefined
const jsx = (): undefined => undefined
const jsxs = (): undefined => undefined

function installRuntime(): TrustedViewsRuntime {
  const runtime = {
    React: { createElement, useState: () => [undefined, () => {}] },
    jsxRuntime: { jsx, jsxs, Fragment: Symbol('fragment') },
  } as unknown as TrustedViewsRuntime
  setTrustedViewsRuntime(runtime)
  return runtime
}

describe('trusted-view runtime', () => {
  it('throws a clear error before the renderer installs the runtime', () => {
    delete (globalThis as unknown as Record<symbol, unknown>)[TRUSTED_VIEWS_RUNTIME_KEY]
    expect(() => getTrustedViewsRuntime()).toThrow(/runtime is not installed/)
  })

  it('exposes the installed React and JSX runtime through the shims', async () => {
    const runtime = installRuntime()
    // Import after installing: the shims resolve their exports at module load.
    const react = await import('../react.js')
    const jsxRuntime = await import('../jsx-runtime.js')

    expect(react.default).toBe(runtime.React)
    expect(react.createElement).toBe(createElement)
    expect(react.useState).toBe(runtime.React.useState)
    expect(jsxRuntime.jsx).toBe(jsx)
    expect(jsxRuntime.jsxs).toBe(jsxs)
    expect(jsxRuntime.Fragment).toBe(runtime.jsxRuntime.Fragment)
  })
})
