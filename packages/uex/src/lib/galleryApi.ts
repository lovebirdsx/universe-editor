/**
 * Marketplace API endpoint paths, relative to the registry base URL. The
 * server side (Phase D, scripts/server/server.mjs) implements these under the
 * same paths — keep this file the single source both sides align on.
 */
export const GALLERY_API = {
  publish: 'gallery/api/publish',
  unpublish: 'gallery/api/unpublish',
  whoami: 'gallery/api/whoami',
  register: 'gallery/api/register',
} as const

/** Self-serve page where an author registers a publisher and gets a one-time token. */
export function registerPageUrl(registryBase: string): string {
  return `${registryBase.replace(/\/+$/, '')}/gallery/register`
}
