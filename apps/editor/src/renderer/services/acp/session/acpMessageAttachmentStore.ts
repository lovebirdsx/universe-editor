/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  ILoggerService,
  IStorageService,
  ITelemetryService,
  IWorkspaceService,
  InstantiationType,
  registerSingleton,
} from '@universe-editor/platform'
import { PersistedStateBase } from '../persistedStateBase.js'
import type { SelectionContext } from '../promptContext.js'

export interface IAcpMessageAttachmentStore {
  readonly _serviceBrand: undefined

  initialize(): Promise<void>
  saveSelections(
    sessionId: string,
    messageId: string,
    selections: readonly SelectionContext[],
  ): void
  getSelections(sessionId: string, messageId: string): readonly SelectionContext[]
  removeMessages(sessionId: string, messageIds: readonly string[]): void
  copySession(
    sourceSessionId: string,
    targetSessionId: string,
    messageIds?: readonly string[],
  ): void
  removeSession(sessionId: string): void
  clear(): void
}

/** Small non-persisting implementation for direct-construction tests. */
export class InMemoryAcpMessageAttachmentStore implements IAcpMessageAttachmentStore {
  declare readonly _serviceBrand: undefined
  private readonly _entries = new Map<string, readonly SelectionContext[]>()

  initialize(): Promise<void> {
    return Promise.resolve()
  }
  saveSelections(
    sessionId: string,
    messageId: string,
    selections: readonly SelectionContext[],
  ): void {
    const key = attachmentKey(sessionId, messageId)
    if (selections.length === 0) this._entries.delete(key)
    else this._entries.set(key, cloneSelections(selections))
  }
  getSelections(sessionId: string, messageId: string): readonly SelectionContext[] {
    return cloneSelections(this._entries.get(attachmentKey(sessionId, messageId)) ?? [])
  }
  removeMessages(sessionId: string, messageIds: readonly string[]): void {
    for (const messageId of messageIds) this._entries.delete(attachmentKey(sessionId, messageId))
  }
  copySession(
    sourceSessionId: string,
    targetSessionId: string,
    messageIds?: readonly string[],
  ): void {
    this.removeSession(targetSessionId)
    const included = messageIds ? new Set(messageIds) : undefined
    for (const [key, selections] of this._entries) {
      const separator = key.indexOf('\0')
      const sessionId = key.slice(0, separator)
      const messageId = key.slice(separator + 1)
      if (sessionId !== sourceSessionId || (included && !included.has(messageId))) continue
      this._entries.set(attachmentKey(targetSessionId, messageId), cloneSelections(selections))
    }
  }
  removeSession(sessionId: string): void {
    for (const key of [...this._entries.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) this._entries.delete(key)
    }
  }
  clear(): void {
    this._entries.clear()
  }
}

export const IAcpMessageAttachmentStore = createDecorator<IAcpMessageAttachmentStore>(
  'acpMessageAttachmentStore',
)

/** Test/direct-construction fallback; production DI always supplies the singleton. */
export const NULL_ACP_MESSAGE_ATTACHMENT_STORE: IAcpMessageAttachmentStore =
  new InMemoryAcpMessageAttachmentStore()

const STORAGE_KEY = 'acp.messageAttachments'
const SCHEMA_VERSION = 1
const SESSION_BYTE_BUDGET = 8 * 1024 * 1024
const TOTAL_BYTE_BUDGET = 32 * 1024 * 1024

export interface AcpMessageAttachmentRecord {
  readonly sessionId: string
  readonly messageId: string
  readonly selections: readonly SelectionContext[]
  readonly updatedAt: number
}

interface PersistedShape {
  readonly schemaVersion: number
  readonly entries: readonly AcpMessageAttachmentRecord[]
}

export interface AcpMessageAttachmentBudgets {
  readonly perSession: number
  readonly total: number
}

export interface AcpMessageAttachmentBudgetResult {
  readonly entries: AcpMessageAttachmentRecord[]
  readonly evicted: number
}

export class AcpMessageAttachmentStore
  extends PersistedStateBase<AcpMessageAttachmentRecord[]>
  implements IAcpMessageAttachmentStore
{
  declare readonly _serviceBrand: undefined

  constructor(
    @IStorageService storage: IStorageService,
    @IWorkspaceService workspace: IWorkspaceService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super(storage, workspace, telemetry, loggerService, {
      storageKey: STORAGE_KEY,
      loggerId: 'acpMessageAttachmentStore',
      loggerName: 'ACP Message Attachments',
      persistFailureEvent: 'acp.message_attachments_persist_failed',
    })
  }

  saveSelections(
    sessionId: string,
    messageId: string,
    selections: readonly SelectionContext[],
  ): void {
    if (!sessionId || !messageId) return
    if (selections.length === 0) {
      this.removeMessages(sessionId, [messageId])
      return
    }

    const next = this._state.filter(
      (entry) => entry.sessionId !== sessionId || entry.messageId !== messageId,
    )
    next.push({
      sessionId,
      messageId,
      selections: cloneSelections(selections),
      updatedAt: Date.now(),
    })
    this._replaceWithBudgeted(next)
  }

  getSelections(sessionId: string, messageId: string): readonly SelectionContext[] {
    const entry = this._state.find(
      (candidate) => candidate.sessionId === sessionId && candidate.messageId === messageId,
    )
    return entry ? cloneSelections(entry.selections) : []
  }

  removeMessages(sessionId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return
    const ids = new Set(messageIds)
    this._replace(
      this._state.filter((entry) => entry.sessionId !== sessionId || !ids.has(entry.messageId)),
    )
  }

  copySession(
    sourceSessionId: string,
    targetSessionId: string,
    messageIds?: readonly string[],
  ): void {
    if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return
    const included = messageIds ? new Set(messageIds) : undefined
    const sourceEntries = this._state.filter(
      (entry) =>
        entry.sessionId === sourceSessionId && (!included || included.has(entry.messageId)),
    )
    const next = this._state.filter((entry) => entry.sessionId !== targetSessionId)
    const now = Date.now()
    for (const entry of sourceEntries) {
      next.push({
        sessionId: targetSessionId,
        messageId: entry.messageId,
        selections: cloneSelections(entry.selections),
        updatedAt: now,
      })
    }
    this._replaceWithBudgeted(next)
  }

  removeSession(sessionId: string): void {
    this._replace(this._state.filter((entry) => entry.sessionId !== sessionId))
  }

  clear(): void {
    this._replace([])
  }

  protected override _emptyState(): AcpMessageAttachmentRecord[] {
    return []
  }

  protected override _serialize(state: AcpMessageAttachmentRecord[]): PersistedShape {
    return { schemaVersion: SCHEMA_VERSION, entries: state }
  }

  protected override _deserialize(raw: unknown): AcpMessageAttachmentRecord[] | undefined {
    if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.entries)) {
      return undefined
    }

    const byKey = new Map<string, AcpMessageAttachmentRecord>()
    for (const value of raw.entries) {
      if (!isAttachmentEntry(value)) return undefined
      byKey.set(attachmentKey(value.sessionId, value.messageId), {
        ...value,
        selections: cloneSelections(value.selections),
      })
    }
    const result = enforceAcpMessageAttachmentBudgets([...byKey.values()], {
      perSession: SESSION_BYTE_BUDGET,
      total: TOTAL_BYTE_BUDGET,
    })
    if (result.evicted > 0) {
      this._logger.warn(
        `evicted ${result.evicted} persisted message attachment record(s) to stay within storage budgets`,
      )
    }
    return result.entries
  }

  protected override _mergeOnLoad(
    loaded: AcpMessageAttachmentRecord[],
    current: AcpMessageAttachmentRecord[],
  ): AcpMessageAttachmentRecord[] {
    const byKey = new Map<string, AcpMessageAttachmentRecord>()
    for (const entry of loaded) byKey.set(attachmentKey(entry.sessionId, entry.messageId), entry)
    for (const entry of current) byKey.set(attachmentKey(entry.sessionId, entry.messageId), entry)
    const result = enforceAcpMessageAttachmentBudgets([...byKey.values()], {
      perSession: SESSION_BYTE_BUDGET,
      total: TOTAL_BYTE_BUDGET,
    })
    if (result.evicted > 0) {
      this._logger.warn(
        `evicted ${result.evicted} merged message attachment record(s) to stay within storage budgets`,
      )
    }
    return result.entries
  }

  protected override _onStateReplaced(): void {}

  private _replace(entries: AcpMessageAttachmentRecord[]): void {
    if (
      entries.length === this._state.length &&
      entries.every((entry, i) => entry === this._state[i])
    ) {
      return
    }
    this._state = entries
    this._scheduleWrite()
  }

  private _replaceWithBudgeted(entries: AcpMessageAttachmentRecord[]): void {
    const result = enforceAcpMessageAttachmentBudgets(entries, {
      perSession: SESSION_BYTE_BUDGET,
      total: TOTAL_BYTE_BUDGET,
    })
    if (result.evicted > 0) {
      this._logger.warn(
        `evicted ${result.evicted} message attachment record(s) to stay within storage budgets`,
      )
    }
    this._replace(result.entries)
  }
}

export function enforceAcpMessageAttachmentBudgets(
  entries: readonly AcpMessageAttachmentRecord[],
  budgets: AcpMessageAttachmentBudgets,
): AcpMessageAttachmentBudgetResult {
  const oldestFirst = [...entries].sort((a, b) => a.updatedAt - b.updatedAt)
  const sizes = new Map<AcpMessageAttachmentRecord, number>()
  const sessionSizes = new Map<string, number>()
  let total = 0
  for (const entry of oldestFirst) {
    const size = byteLength(entry)
    sizes.set(entry, size)
    sessionSizes.set(entry.sessionId, (sessionSizes.get(entry.sessionId) ?? 0) + size)
    total += size
  }

  const removed = new Set<AcpMessageAttachmentRecord>()
  for (const entry of oldestFirst) {
    const sessionSize = sessionSizes.get(entry.sessionId) ?? 0
    if (sessionSize <= budgets.perSession) continue
    const size = sizes.get(entry) ?? 0
    removed.add(entry)
    sessionSizes.set(entry.sessionId, sessionSize - size)
    total -= size
  }
  for (const entry of oldestFirst) {
    if (total <= budgets.total) break
    if (removed.has(entry)) continue
    const size = sizes.get(entry) ?? 0
    removed.add(entry)
    total -= size
  }
  return { entries: entries.filter((entry) => !removed.has(entry)), evicted: removed.size }
}

function byteLength(entry: AcpMessageAttachmentRecord): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength
}

function cloneSelections(selections: readonly SelectionContext[]): SelectionContext[] {
  return selections.map((selection) => ({ ...selection }))
}

function attachmentKey(sessionId: string, messageId: string): string {
  return `${sessionId}\0${messageId}`
}

function isAttachmentEntry(value: unknown): value is AcpMessageAttachmentRecord {
  if (!isRecord(value)) return false
  return (
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt) &&
    Array.isArray(value.selections) &&
    value.selections.length > 0 &&
    value.selections.every(isSelectionContext)
  )
}

function isSelectionContext(value: unknown): value is SelectionContext {
  if (!isRecord(value)) return false
  return (
    typeof value.uri === 'string' &&
    typeof value.relPath === 'string' &&
    typeof value.text === 'string' &&
    Number.isInteger(value.startLine) &&
    (value.startLine as number) >= 1 &&
    Number.isInteger(value.endLine) &&
    (value.endLine as number) >= (value.startLine as number) &&
    (value.languageId === undefined || typeof value.languageId === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

registerSingleton(IAcpMessageAttachmentStore, AcpMessageAttachmentStore, InstantiationType.Delayed)
