/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Manifest localization (NLS), mirroring VSCode's `package.nls.json` scheme. This
 *  is the listing-side copy — the extension host ships its own in
 *  `packages/extension-host/src/nls.ts` (localizes contributions for activation);
 *  this one localizes manifests for the Extensions UI and (later) the remote
 *  server. Keep the two in sync.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** A flat map of nls key → translated string, as stored in a `package.nls*.json`. */
export type NlsBundle = Readonly<Record<string, string>>

const NLS_PLACEHOLDER = /^%([\w.-]+)%$/

async function readNlsBundle(filePath: string): Promise<NlsBundle | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
    if (parsed && typeof parsed === 'object') return parsed as NlsBundle
  } catch {
    // absent or unreadable bundle → no translation for that file
  }
  return undefined
}

/** Default bundle merged with the per-locale override (locale wins per key). */
export async function loadNlsBundle(
  extensionPath: string,
  locale?: string,
): Promise<NlsBundle | undefined> {
  const defaultBundle = await readNlsBundle(path.join(extensionPath, 'package.nls.json'))
  const localeBundle =
    locale && locale.toLowerCase() !== 'en' && locale.toLowerCase() !== 'en-us'
      ? await readNlsBundle(path.join(extensionPath, `package.nls.${locale.toLowerCase()}.json`))
      : undefined
  if (!defaultBundle && !localeBundle) return undefined
  return { ...defaultBundle, ...localeBundle }
}

/** Deep-clone `value`, translating every whole-string `%key%` placeholder. */
export function localizeManifest<T>(value: T, bundle: NlsBundle): T {
  if (typeof value === 'string') {
    const match = NLS_PLACEHOLDER.exec(value)
    if (!match) return value
    const key = match[1]!
    return (key in bundle ? bundle[key]! : value) as T
  }
  if (Array.isArray(value)) return value.map((item) => localizeManifest(item, bundle)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = localizeManifest(v, bundle)
    return out as T
  }
  return value
}

/** Read `package.json` from an extension folder with `%key%` placeholders localized. */
export async function readManifestJson(location: string, locale?: string): Promise<unknown> {
  const raw: unknown = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'))
  const bundle = await loadNlsBundle(location, locale)
  return bundle ? localizeManifest(raw, bundle) : raw
}
