/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persistence for session deliveries. One GLOBAL key per repository bucket so
 *  two windows working on different repositories never overwrite each other's
 *  history; the git-extension lock arbitrates concurrent deliveries of the SAME
 *  repository. Only the most recent records per repository are retained.
 *--------------------------------------------------------------------------------------------*/

import {
  IStorageService,
  InstantiationType,
  createDecorator,
  registerSingleton,
} from '@universe-editor/platform'
import type { SessionDeliveryRecord } from './sessionDeliveryTypes.js'

export const SESSION_DELIVERY_STORAGE_PREFIX = 'acp.sessionDelivery.v1'
export const SESSION_DELIVERY_INDEX_KEY = `${SESSION_DELIVERY_STORAGE_PREFIX}.index`
export const SESSION_DELIVERY_SCHEMA_VERSION = 1
export const MAX_DELIVERIES_PER_REPOSITORY = 10

export interface SessionDeliveryRepoState {
  readonly version: number
  readonly activeId?: string
  readonly records: readonly SessionDeliveryRecord[]
}

/** Stable short key for a repository's git common dir (case/separator folded). */
export async function sessionDeliveryRepositoryKey(commonDir: string): Promise<string> {
  const normalized = commonDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  )
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function sessionDeliveryStorageKey(repositoryKey: string): string {
  return `${SESSION_DELIVERY_STORAGE_PREFIX}.${repositoryKey}`
}

function isRecord(value: unknown): value is SessionDeliveryRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<SessionDeliveryRecord>
  return (
    typeof record.id === 'string' &&
    typeof record.repositoryKey === 'string' &&
    typeof record.commonDir === 'string' &&
    typeof record.phase === 'string' &&
    typeof record.source === 'object' &&
    record.source !== null &&
    typeof record.target === 'object' &&
    record.target !== null
  )
}

function parseRepoState(raw: unknown): SessionDeliveryRepoState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const state = raw as { version?: unknown; activeId?: unknown; records?: unknown }
  if (state.version !== SESSION_DELIVERY_SCHEMA_VERSION) return undefined
  const records = Array.isArray(state.records) ? state.records.filter(isRecord) : []
  return {
    version: SESSION_DELIVERY_SCHEMA_VERSION,
    ...(typeof state.activeId === 'string' ? { activeId: state.activeId } : {}),
    records,
  }
}

export interface ISessionDeliveryStore {
  readonly _serviceBrand: undefined
  listRepositoryKeys(): Promise<readonly string[]>
  readRepository(key: string): Promise<SessionDeliveryRepoState | undefined>
  writeRepository(key: string, state: SessionDeliveryRepoState): Promise<void>
  /** Register a bucket so `initialize` can find it again after a restart. */
  rememberRepository(key: string): Promise<void>
}

export const ISessionDeliveryStore = createDecorator<ISessionDeliveryStore>('sessionDeliveryStore')

export class SessionDeliveryStore implements ISessionDeliveryStore {
  declare readonly _serviceBrand: undefined

  constructor(@IStorageService private readonly _storage: IStorageService) {}

  async listRepositoryKeys(): Promise<readonly string[]> {
    const raw = await this._storage.get<unknown>(SESSION_DELIVERY_INDEX_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((key): key is string => typeof key === 'string' && key.length > 0)
  }

  async readRepository(key: string): Promise<SessionDeliveryRepoState | undefined> {
    return parseRepoState(await this._storage.get<unknown>(sessionDeliveryStorageKey(key)))
  }

  async writeRepository(key: string, state: SessionDeliveryRepoState): Promise<void> {
    await this._storage.set(sessionDeliveryStorageKey(key), {
      version: SESSION_DELIVERY_SCHEMA_VERSION,
      ...(state.activeId !== undefined ? { activeId: state.activeId } : {}),
      records: state.records,
    })
  }

  async rememberRepository(key: string): Promise<void> {
    const keys = await this.listRepositoryKeys()
    if (keys.includes(key)) return
    await this._storage.set(SESSION_DELIVERY_INDEX_KEY, [...keys, key])
  }
}

registerSingleton(ISessionDeliveryStore, SessionDeliveryStore, InstantiationType.Delayed)
