// Protocol infrastructure: RPC channels, stdio framing, webview URL/byte helpers.
// Everything the extension host machinery is built on, independent of any one
// domain feature.
//
// Manifest types / activation events / categories / semver live in
// `@universe-editor/extension-manifest` (published for out-of-repo extension
// authors + the packaging toolchain); re-exported here so in-repo consumers keep
// a single import surface. Its `manifest-schema` stays off this barrel (zod
// isolation) and is reached via the `./manifest-schema.js` passthrough.
export * from '@universe-editor/extension-manifest'
export * from './rpc.js'
export * from './stdioProtocol.js'
export * from './bytes.js'
export * from './webviewProtocol.js'
