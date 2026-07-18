/*---------------------------------------------------------------------------------------------
 *  E2E probe contract — app-side barrel.
 *
 *  The contract itself (probe interface, DTO types, runtime key constants, and the
 *  `window.__E2E__` global augmentation) lives in the playwright-free package
 *  `@universe-editor/e2e-contract`, so the e2e-harness and per-extension e2e suites
 *  can share the SAME probe types without depending on the app. This barrel
 *  re-exports it at the historical path so the app's main/preload/renderer import
 *  sites stay unchanged; importing it also pulls in the module's `declare global`.
 *
 *  See:
 *    - apps/editor/src/main/index.ts          (env → additionalArguments)
 *    - apps/editor/src/preload/index.ts       (argv → window.__UNIVERSE_E2E_ENABLED__)
 *    - apps/editor/src/renderer/e2e/probe.ts  (probe installation)
 *--------------------------------------------------------------------------------------------*/

export * from '@universe-editor/e2e-contract'
