/**
 * Trust decision for `contributes.trustedViews` — the single source of truth
 * shared by the translator (registration gate) and `ExtensionsContribution`
 * (the "trust and load" prompt).
 *
 * A trusted view runs in the renderer's realm with a restricted ctx, which is a
 * contract boundary rather than a sandbox. Only built-ins, dev extensions
 * (`--extension-development-path`) and ids the user listed in
 * `extensions.trustedViewExtensions` may load. The setting is read from the
 * User layer only — a workspace's `.vscode/settings.json` must not be able to
 * grant renderer code execution just by opening a folder.
 */
import { ConfigurationTarget, type IConfigurationService } from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'

export const TRUSTED_VIEW_EXTENSIONS_SETTING = 'extensions.trustedViewExtensions'

export type TrustedViewExtensionInfo = Pick<
  IExtensionDescriptionDto,
  'id' | 'extensionIsBuiltin' | 'extensionIsUnderDevelopment'
>

/** Built-in / dev extensions are implicitly trusted; others need an explicit id match. */
export function isTrustedViewExtension(
  ext: TrustedViewExtensionInfo,
  trustedIds: readonly string[],
): boolean {
  if (ext.extensionIsBuiltin || ext.extensionIsUnderDevelopment === true) return true
  const id = ext.id.toLowerCase()
  return trustedIds.some((trusted) => trusted.toLowerCase() === id)
}

export function normalizeTrustedViewIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  )
}

/**
 * Read the User-layer list. `getValueForTarget(User)` deliberately ignores
 * Project / VSCodeWorkspace / Memory layers (see IConfigurationService).
 */
export function readTrustedViewExtensions(configuration: IConfigurationService): string[] {
  return normalizeTrustedViewIds(
    configuration.getValueForTarget<unknown>(
      TRUSTED_VIEW_EXTENSIONS_SETTING,
      ConfigurationTarget.User,
    ),
  )
}

/** Order-independent signature for change detection between re-translations. */
export function trustedViewIdsSignature(ids: readonly string[]): string {
  return [...ids.map((id) => id.toLowerCase())].sort().join('\n')
}
