import { configure } from '@testing-library/react'

// Mirror the root StrictMode in src/renderer/main.tsx so dev-only double-invoked
// effects (non-idempotent cleanup) fail in unit tests. Opt-in per project:
// renderer-dom enables this; renderer-dom-legacy keeps known offenders running
// without it until they are fixed (list in vitest.config.ts).
configure({ reactStrictMode: true })
