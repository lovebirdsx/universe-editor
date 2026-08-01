/*---------------------------------------------------------------------------------------------
 *  Extension-development mode contract — main → preload → renderer flag channel.
 *
 *  Mirrors the E2E probe's three-hop pattern (shared/e2e/contract.ts) but is NOT
 *  e2e-specific, so it lives outside the e2e barrel:
 *    - main/index.ts              (--extension-development-path → extensionDevelopment option)
 *    - main windowMainService     (option → additionalArguments argv flag)
 *    - preload/index.ts           (argv → window.__UNIVERSE_EXTENSION_DEVELOPMENT__)
 *    - renderer consumers         (window title badge, status bar entry, extensions UI)
 *--------------------------------------------------------------------------------------------*/

/** argv flag injected into the renderer by WindowMainService in ext-dev mode. */
export const EXTENSION_DEVELOPMENT_ARGV_FLAG = '--extension-development'

/** Global key the preload exposes when EXTENSION_DEVELOPMENT_ARGV_FLAG is present. */
export const EXTENSION_DEVELOPMENT_ENABLED_KEY = '__UNIVERSE_EXTENSION_DEVELOPMENT__'

declare global {
  interface Window {
    [EXTENSION_DEVELOPMENT_ENABLED_KEY]?: boolean
  }
}
