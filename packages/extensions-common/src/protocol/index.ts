// Protocol infrastructure: RPC channels, stdio framing, manifest + semver +
// activation parsing, webview URL/byte helpers. Everything the extension host
// machinery is built on, independent of any one domain feature.
//
// `manifest-schema.ts` is deliberately NOT re-exported here — importing it pulls
// in zod, which the renderer must not bundle just to read manifest *types*. It is
// reached via the `@universe-editor/extensions-common/manifest-schema` subpath.
export * from './rpc.js'
export * from './manifest.js'
export * from './categories.js'
export * from './activation.js'
export * from './stdioProtocol.js'
export * from './semver.js'
export * from './bytes.js'
export * from './webviewProtocol.js'
