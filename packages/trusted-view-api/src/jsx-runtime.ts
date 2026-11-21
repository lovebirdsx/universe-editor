/** `react/jsx-runtime` shim for trusted-view component builds (automatic JSX). */
import { getTrustedViewsRuntime } from './runtime.js'

const { jsxRuntime } = getTrustedViewsRuntime()

export const Fragment = jsxRuntime.Fragment
export const jsx = jsxRuntime.jsx
export const jsxs = jsxRuntime.jsxs
