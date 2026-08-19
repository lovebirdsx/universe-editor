import type { SdkVersions } from './sdkVersions.js'

export interface ScaffoldAnswers {
  readonly name: string
  readonly publisher: string
  readonly displayName: string
  readonly description: string
  readonly template: 'basic' | 'webview'
}

/**
 * Map of `__token__` → replacement used across template files. Token names
 * are deliberately unique (double-underscore wrapped) so they can never
 * collide with real project content.
 */
export function buildPlaceholders(
  answers: ScaffoldAnswers,
  versions: SdkVersions,
): Record<string, string> {
  return {
    __name__: answers.name,
    __publisher__: answers.publisher,
    __displayName__: answers.displayName,
    __description__: answers.description,
    __apiVersion__: versions.extensionApi,
    __uexVersion__: versions.uex,
    __esbuildVersion__: versions.esbuild,
    __tsVersion__: versions.typescript,
    __nodeTypesVersion__: versions.nodeTypes,
    __vitestVersion__: versions.vitest,
    __playwrightVersion__: versions.playwright,
    __e2eHarnessVersion__: versions.e2eHarness,
    __e2eContractVersion__: versions.e2eContract,
    // Host semver fails closed on ^ / || / hyphen ranges — the generated
    // range is the one form guaranteed to load (see engines red line).
    __enginesUniverse__: `>=${versions.extensionApi} <1.0.0`,
  }
}
