import { configure } from '@testing-library/react'

// Mirror the root StrictMode in src/renderer/main.tsx so dev-only double-invoked
// effects (non-idempotent cleanup) fail in unit tests.
configure({ reactStrictMode: true })
