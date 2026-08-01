/**
 * Registry URL and publish token resolution. Mirrors the editor's GALLERY_URL
 * semantics: there is no built-in default — an unconfigured registry is a
 * hard error with the three ways to fix it.
 */
import { UexError } from '../errors.js'
import type { UexConfigFile } from './configFile.js'

export interface RegistrySources {
  readonly flag?: string | undefined
  readonly env: { readonly [key: string]: string | undefined }
  readonly config: UexConfigFile
}

export function normalizeRegistry(url: string): string {
  return url.replace(/\/+$/, '')
}

export function resolveRegistry(sources: RegistrySources): string {
  const flag = sources.flag
  if (flag) return normalizeRegistry(flag)
  const env = sources.env.UNIVERSE_GALLERY_URL
  if (env) return normalizeRegistry(env)
  if (sources.config.defaultRegistry) return normalizeRegistry(sources.config.defaultRegistry)
  const buckets = Object.keys(sources.config.registries ?? {})
  if (buckets.length === 1) return normalizeRegistry(buckets[0]!)
  throw new UexError('no marketplace registry configured', [
    'pass --registry <url>',
    'or set UNIVERSE_GALLERY_URL',
    'or run `uex login` to save one to ~/.uex/config.json',
  ])
}

export function resolveToken(sources: {
  readonly env: { readonly [key: string]: string | undefined }
  readonly config: UexConfigFile
  readonly registry: string
}): string {
  const envToken = sources.env.UNIVERSE_MARKET_TOKEN
  if (envToken) return envToken
  const bucket = sources.config.registries?.[normalizeRegistry(sources.registry)]
  if (bucket?.token) return bucket.token
  throw new UexError(`no publish token for ${sources.registry}`, [
    'run `uex login <publisher>` to store one',
    'or set UNIVERSE_MARKET_TOKEN (CI)',
  ])
}
