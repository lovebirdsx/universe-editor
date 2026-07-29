// Package barrel: manifest types, activation events, categories, semver.
//
// `manifest-schema.ts` is deliberately NOT re-exported here — importing it pulls
// in zod, which the renderer must not bundle just to read manifest *types*. It is
// reached via the `@universe-editor/extension-manifest/manifest-schema` subpath.
export * from './activation.js'
export * from './manifest.js'
export * from './categories.js'
export * from './semver.js'
