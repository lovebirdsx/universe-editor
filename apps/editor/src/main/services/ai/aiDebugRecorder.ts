/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Records every AI request that flows through the "direct provider" path
 *  (AiModelMainService). Each request is captured in memory, mirrored to a
 *  human-readable "AI Debug" log channel (visible in the Output panel) and
 *  appended as one structured JSONL line under the current log session dir, so
 *  it is grep-able and auto-cleaned with the session. Records hold no API keys —
 *  request options never carry secrets.
 *--------------------------------------------------------------------------------------------*/

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createDecorator,
  createNamedLogger,
  Disposable,
  Emitter,
  generateUuid,
  type AiDebugChunk,
  type AiDebugMessage,
  type AiDebugRecord,
  type AiDebugRecordSummary,
  type AiDebugStatus,
  type AiMessage,
  type AiRequestOptions,
  type AiResponseChunk,
  type ILogger,
  ILoggerService,
  type SerializedError,
} from '@universe-editor/platform'
import { ILogMainService, type LogMainService } from '../log/logMainService.js'

/** Internal main-only decorator: AiModelMainService writes, AiDebugMainService reads. */
export const IAiDebugRecorderService = createDecorator<AiDebugRecorder>('aiDebugRecorderService')

const AI_DEBUG_JSONL = 'ai-debug.jsonl'
/** In-memory ring buffer cap; the JSONL file keeps the full history for the session. */
const MAX_RECENT = 200
const PREVIEW_LEN = 120

interface MutableRecord {
  readonly id: string
  readonly requestId: string
  readonly purpose?: AiRequestOptions['purpose']
  readonly debugLabel?: string
  readonly modelId: string
  readonly vendor: string
  readonly groupName?: string
  readonly startedAt: number
  readonly messages: readonly AiDebugMessage[]
  readonly options: Omit<AiRequestOptions, 'modelId' | 'purpose' | 'debugLabel'>
  readonly chunks: AiDebugChunk[]
  responseText: string
  usage?: { inputTokens: number; outputTokens: number }
}

export class AiDebugRecorder extends Disposable {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _active = new Map<string, MutableRecord>()
  private readonly _recent: AiDebugRecord[] = []
  private _enabled = true

  private readonly _onDidRecordRequest = this._register(new Emitter<AiDebugRecordSummary>())
  readonly onDidRecordRequest = this._onDidRecordRequest.event

  private readonly _onDidClear = this._register(new Emitter<void>())
  readonly onDidClear = this._onDidClear.event

  constructor(
    @ILogMainService private readonly _logMain: LogMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'aiDebug', name: 'AI Debug' })
  }

  isEnabled(): boolean {
    return this._enabled
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled
  }

  begin(requestId: string, messages: readonly AiMessage[], options: AiRequestOptions): void {
    if (!this._enabled) return
    const { modelId, purpose, debugLabel, ...rest } = options
    const ref = parseModelId(modelId)
    const record: MutableRecord = {
      id: generateUuid(),
      requestId,
      ...(purpose !== undefined ? { purpose } : {}),
      ...(debugLabel !== undefined ? { debugLabel } : {}),
      modelId,
      vendor: ref.vendor,
      ...(ref.group !== undefined ? { groupName: ref.group } : {}),
      startedAt: Date.now(),
      messages: messages.map(toDebugMessage),
      options: rest,
      chunks: [],
      responseText: '',
    }
    this._active.set(requestId, record)
    this._logger.info(
      `▶ [${purpose ?? 'unknown'}] ${modelId} req=${requestId}\n${promptDigest(record.messages)}`,
    )
  }

  recordChunk(requestId: string, chunk: AiResponseChunk): void {
    const record = this._active.get(requestId)
    if (!record) return
    record.chunks.push({ atMs: Date.now() - record.startedAt, chunk })
    if (chunk.type === 'text') {
      record.responseText += chunk.value
    } else {
      record.usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }
    }
  }

  finish(requestId: string, error?: SerializedError): void {
    const record = this._active.get(requestId)
    if (!record) return
    this._active.delete(requestId)

    const endedAt = Date.now()
    const durationMs = endedAt - record.startedAt
    const status: AiDebugStatus = error ? (isCanceled(error) ? 'canceled' : 'error') : 'ok'
    const final: AiDebugRecord = {
      id: record.id,
      requestId: record.requestId,
      ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
      ...(record.debugLabel !== undefined ? { debugLabel: record.debugLabel } : {}),
      modelId: record.modelId,
      vendor: record.vendor,
      ...(record.groupName !== undefined ? { groupName: record.groupName } : {}),
      startedAt: record.startedAt,
      endedAt,
      durationMs,
      status,
      messages: record.messages,
      options: record.options,
      responseText: record.responseText,
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
      chunks: record.chunks,
      ...(error !== undefined ? { error } : {}),
    }

    this._recent.push(final)
    if (this._recent.length > MAX_RECENT) this._recent.shift()

    const usageText = final.usage
      ? ` ${final.usage.inputTokens}→${final.usage.outputTokens}tok`
      : ''
    const tail = error ? `error: ${error.message ?? status}` : preview(final.responseText)
    this._logger.info(`◀ ${status} ${durationMs}ms${usageText} req=${requestId}\n${tail}`)

    void this._appendJsonl(final)
    this._onDidRecordRequest.fire(toSummary(final))
  }

  listRecords(opts?: { limit?: number; offset?: number }): readonly AiDebugRecordSummary[] {
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? this._recent.length
    // Newest first.
    const ordered = [...this._recent].reverse()
    return ordered.slice(offset, offset + limit).map(toSummary)
  }

  getRecord(id: string): AiDebugRecord | undefined {
    return this._recent.find((r) => r.id === id)
  }

  clearRecords(): void {
    this._recent.length = 0
    this._onDidClear.fire()
  }

  private async _appendJsonl(record: AiDebugRecord): Promise<void> {
    try {
      const path = join(this._logMain.getSessionDir(), AI_DEBUG_JSONL)
      await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
    } catch {
      // Recording must never affect the AI request — swallow write failures.
    }
  }
}

function toDebugMessage(message: AiMessage): AiDebugMessage {
  const text = message.content
    .map((part) =>
      part.type === 'text' ? part.value : `[image ${part.mimeType}, ${part.data.byteLength} bytes]`,
    )
    .join('')
  return { role: message.role, text }
}

function toSummary(record: AiDebugRecord): AiDebugRecordSummary {
  return {
    id: record.id,
    ...(record.purpose !== undefined ? { purpose: record.purpose } : {}),
    ...(record.debugLabel !== undefined ? { debugLabel: record.debugLabel } : {}),
    modelId: record.modelId,
    startedAt: record.startedAt,
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    status: record.status,
    responsePreview: preview(record.responseText),
    ...(record.usage !== undefined ? { tokens: record.usage } : {}),
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN) + '…' : flat
}

function promptDigest(messages: readonly AiDebugMessage[]): string {
  return messages.map((m) => `  [${roleLabel(m.role)}] ${preview(m.text)}`).join('\n')
}

function roleLabel(role: number): string {
  return role === 0 ? 'system' : role === 1 ? 'user' : 'assistant'
}

function isCanceled(error: SerializedError): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'canceled' || error.name === 'Canceled' || error.name === 'AbortError'
}

function parseModelId(modelId: string): { vendor: string; group?: string } {
  const parts = modelId.split('/')
  if (parts.length >= 2 && parts[0] && parts[1]) return { vendor: parts[0], group: parts[1] }
  return { vendor: parts[0] ?? modelId }
}
