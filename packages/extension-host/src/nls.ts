/**
 * Manifest localization (NLS), mirroring VSCode's `package.nls.json` scheme.
 *
 * An extension declares user-facing strings in its manifest as `%key%`
 * placeholders (e.g. `"title": "%git.commit.title%"`) and ships the translations
 * in sibling files next to `package.json`:
 *   - `package.nls.json`            — the default (English) bundle, always required
 *   - `package.nls.<locale>.json`   — a per-locale override, e.g. `package.nls.zh-cn.json`
 *
 * At scan time we load the locale bundle (falling back to the default per key),
 * then walk the raw manifest replacing every `%key%` string with its translation.
 * A string that is exactly `%key%` becomes the translated value; a key with no
 * entry is left as-is (the literal `%key%`) so a missing translation is visible
 * rather than silently blank — same behavior as VSCode.
 */
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

/** A flat map of nls key → translated string, as stored in a `package.nls*.json`. */
export type NlsBundle = Readonly<Record<string, string>>

/** Matches a whole string that is a single `%key%` placeholder (VSCode convention). */
const PLACEHOLDER = /^%([\w.-]+)%$/

function nlsFileName(locale?: string): string {
  return locale ? `package.nls.${locale.toLowerCase()}.json` : 'package.nls.json'
}

async function readBundle(filePath: string): Promise<NlsBundle | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed as NlsBundle
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `[ext-host] failed to read ${path.basename(filePath)}: ${(err as Error).message}`,
      )
    }
  }
  return undefined
}

/**
 * Load an extension's nls bundle for `locale`, merged over the default bundle so
 * a key missing in the locale file falls back to English. Returns `undefined`
 * when the extension ships no nls files at all (nothing to translate).
 */
export async function loadNlsBundle(
  extensionPath: string,
  locale?: string,
): Promise<NlsBundle | undefined> {
  const defaultBundle = await readBundle(path.join(extensionPath, nlsFileName()))
  const localeBundle =
    locale && locale.toLowerCase() !== 'en' && locale.toLowerCase() !== 'en-us'
      ? await readBundle(path.join(extensionPath, nlsFileName(locale)))
      : undefined
  if (!defaultBundle && !localeBundle) return undefined
  return { ...defaultBundle, ...localeBundle }
}

/** Replace a single `%key%` string via the bundle, or return it unchanged. */
function translateString(value: string, bundle: NlsBundle): string {
  const match = PLACEHOLDER.exec(value)
  if (!match) return value
  const key = match[1]!
  return key in bundle ? bundle[key]! : value
}

/**
 * Deep-clone `value`, replacing every `%key%` placeholder string with its
 * translation from `bundle`. Non-placeholder strings, numbers, booleans, and
 * null pass through untouched. Object keys are never translated — only values.
 */
export function localizeManifest<T>(value: T, bundle: NlsBundle): T {
  if (typeof value === 'string') return translateString(value, bundle) as T
  if (Array.isArray(value)) return value.map((item) => localizeManifest(item, bundle)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = localizeManifest(v, bundle)
    return out as T
  }
  return value
}
