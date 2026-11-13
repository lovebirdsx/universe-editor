/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  VAPID key pair persistence for Web Push. Generated once and stored at
 *  `<userData>/mobile/vapid.json` with 0600 permissions; the private key signs
 *  every push request, so it must never be logged or shipped.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import { generateVAPIDKeys } from 'web-push'
import { writeJsonAtomic } from '../jsonConfig/atomicFile.js'

const FILE_VERSION = 1

export interface VapidKeyPair {
  readonly publicKey: string
  readonly privateKey: string
}

export interface VapidKeyStoreOptions {
  readonly generate?: () => VapidKeyPair
  readonly onCorrupt?: (error: Error) => void
  readonly onChmodError?: (error: Error) => void
}

interface VapidFile {
  readonly version: number
  readonly publicKey: string
  readonly privateKey: string
  readonly createdAt: number
}

/**
 * Load the persisted key pair, generating and writing a new one when the file
 * is missing or unreadable. A corrupt file is replaced rather than blocking
 * push: subscriptions made against the old key simply stop decrypting.
 */
export async function loadOrCreateVapidKeys(
  file: string,
  options: VapidKeyStoreOptions = {},
): Promise<VapidKeyPair> {
  const existing = await readExisting(file, options)
  if (existing !== undefined) return existing

  const generated = (options.generate ?? generateVAPIDKeys)()
  if (
    typeof generated.publicKey !== 'string' ||
    generated.publicKey === '' ||
    typeof generated.privateKey !== 'string' ||
    generated.privateKey === ''
  ) {
    throw new Error('VAPID key generation returned an empty key pair')
  }
  const payload: VapidFile = {
    version: FILE_VERSION,
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    createdAt: Date.now(),
  }
  await writeJsonAtomic(file, payload, options.onChmodError)
  return { publicKey: generated.publicKey, privateKey: generated.privateKey }
}

async function readExisting(
  file: string,
  options: VapidKeyStoreOptions,
): Promise<VapidKeyPair | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.onCorrupt?.(toError(err))
    }
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isVapidFile(parsed)) {
      options.onCorrupt?.(new Error('vapid.json has an unexpected shape'))
      return undefined
    }
    if (parsed.version !== FILE_VERSION) {
      options.onCorrupt?.(
        new Error(`vapid.json version ${String(parsed.version)} is not supported`),
      )
      return undefined
    }
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
  } catch (err) {
    options.onCorrupt?.(toError(err))
    return undefined
  }
}

function isVapidFile(value: unknown): value is VapidFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['version'] === 'number' &&
    typeof record['publicKey'] === 'string' &&
    record['publicKey'] !== '' &&
    typeof record['privateKey'] === 'string' &&
    record['privateKey'] !== '' &&
    typeof record['createdAt'] === 'number'
  )
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
