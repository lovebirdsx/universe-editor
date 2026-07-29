// Passthrough keeping the `./manifest-schema` subpath stable: the schema moved
// to `@universe-editor/extension-manifest/manifest-schema`. Deliberately NOT
// re-exported from the barrel — importing it pulls in zod, which the renderer
// must not bundle just to read manifest *types*.
export * from '@universe-editor/extension-manifest/manifest-schema'
