/*---------------------------------------------------------------------------------------------
 *  Product configuration defaults — build-time defaults for settings.json keys.
 *
 *  Ranks above a setting's own schema `default` and below every writable
 *  configuration layer, so a packaged build works out of the box while the user's
 *  settings.json still wins. Four hops, mirroring shared/extensionDevelopment.ts:
 *    - main environmentMainService  (resources/product.json's configurationDefaults
 *                                    + UNIVERSE_CONFIGURATION_DEFAULTS env override)
 *    - main windowMainService       (value → base64 argv flag)
 *    - preload/index.ts             (argv → window.ipc.configurationDefaults)
 *    - renderer main.tsx            (→ ConfigurationRegistry.registerDefaultOverrides,
 *                                    before ConfigurationService is constructed)
 *
 *  The build-time source of truth for which env var maps to which settings key is
 *  scripts/lib/productDefaults.mjs.
 *--------------------------------------------------------------------------------------------*/

/**
 * argv flag carrying the serialized defaults from main into the renderer.
 *
 * The value is base64 of the JSON, not the JSON itself: this is the only argv flag
 * in the app whose value would otherwise contain `"` and spaces, and it is written
 * by Chromium then read back by Node — base64 keeps it out of both quoting rules.
 * It also keeps injected internal addresses out of the OS process list, which is
 * the point of injecting them at build time rather than hardcoding them.
 */
export const CONFIGURATION_DEFAULTS_ARGV_FLAG = '--ue-configuration-defaults='

export type ConfigurationDefaults = Readonly<Record<string, unknown>>

/**
 * Parse a JSON object of settings defaults. Returns an empty object for anything
 * that isn't a plain JSON object — a malformed value must degrade to "no product
 * defaults" rather than break startup (same tolerance as resolveMarketplaceSigningKeys).
 *
 * Only the top level is snapshotted by the registry, so nested object/array values
 * stay shared with the parsed input; all injected values are strings today.
 */
export function parseConfigurationDefaults(text: string | undefined): ConfigurationDefaults {
  if (text === undefined || text === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ConfigurationDefaults
  } catch {
    return {}
  }
}

/** Encode defaults for the argv flag. Returns undefined when there is nothing to pass. */
export function encodeConfigurationDefaultsArg(
  defaults: ConfigurationDefaults,
): string | undefined {
  if (Object.keys(defaults).length === 0) return undefined
  const encoded = Buffer.from(JSON.stringify(defaults), 'utf8').toString('base64')
  return `${CONFIGURATION_DEFAULTS_ARGV_FLAG}${encoded}`
}

/** Read the defaults out of a process argv list (preload side of the flag). */
export function parseConfigurationDefaultsArg(argv: readonly string[]): ConfigurationDefaults {
  const arg = argv.find((a) => a.startsWith(CONFIGURATION_DEFAULTS_ARGV_FLAG))
  if (arg === undefined) return {}
  const encoded = arg.slice(CONFIGURATION_DEFAULTS_ARGV_FLAG.length)
  if (encoded === '') return {}
  try {
    return parseConfigurationDefaults(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return {}
  }
}
