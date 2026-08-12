/**
 * Versions baked into generated projects. `extensionApi`/`uex` are guarded by
 * a test that reads the sibling packages' package.json, so an API/CLI bump
 * without a matching bump here fails loudly.
 */
export interface SdkVersions {
  readonly extensionApi: string
  readonly uex: string
  readonly esbuild: string
  readonly typescript: string
  readonly nodeTypes: string
}

export const SDK_VERSIONS: SdkVersions = {
  extensionApi: '0.12.0',
  uex: '0.1.0',
  esbuild: '^0.25.0',
  typescript: '^5.8.0',
  nodeTypes: '^22.0.0',
}
