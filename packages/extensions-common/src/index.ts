// Package barrel. Grouped into three layers (see 04·任务2):
//   protocol/  — extension-host RPC + manifest/semver/activation infrastructure
//   contracts/ — domain wire DTOs crossing the renderer↔extension boundary
//   glob/      — shared glob→RegExp compiler (findFiles + file watchers)
// Consumers keep importing from the package root; the split is internal.
//
// `manifest-schema` stays off the barrel (zod isolation) — see protocol/index.ts.
export * from './protocol/index.js'
export * from './contracts/index.js'
export * from './glob/index.js'
export * from './installedExtensions.js'
