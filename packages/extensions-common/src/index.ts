// Package barrel. Grouped into two layers (see 04·任务2):
//   protocol/  — extension-host RPC + manifest/semver/activation infrastructure
//   contracts/ — domain wire DTOs crossing the renderer↔extension boundary
// Consumers keep importing from the package root; the split is internal.
//
// `manifest-schema` stays off the barrel (zod isolation) — see protocol/index.ts.
export * from './protocol/index.js'
export * from './contracts/index.js'
