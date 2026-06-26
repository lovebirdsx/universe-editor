/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiDebugView — the "AI Debug" viewlet. Lists every recorded "direct provider"
 *  AI request (newest first) and shows the full prompt / response / options /
 *  usage / error of the selected one. A record can be replayed offline as mock
 *  data (no model call) to reproduce streaming behaviour.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  localize,
  type AiDebugRecord,
  type AiDebugRecordSummary,
  type AiResponseChunk,
} from '@universe-editor/platform'
import { IAiDebugService } from '../../../shared/ipc/aiDebugService.js'
import { useService } from '../useService.js'
import styles from './AiDebugView.module.css'

export function AiDebugView() {
  const service = useService(IAiDebugService)
  const [records, setRecords] = useState<readonly AiDebugRecordSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const refresh = useCallback(() => {
    void service.listRecords().then(setRecords)
  }, [service])

  useEffect(() => {
    refresh()
    const subRecord = service.onDidRecordRequest(() => refresh())
    const subClear = service.onDidClear(() => {
      setSelectedId(undefined)
      refresh()
    })
    return () => {
      subRecord.dispose()
      subClear.dispose()
    }
  }, [service, refresh])

  return (
    <div className={styles['view']} data-testid="ai-debug-view">
      <div className={styles['toolbar']}>
        <span className={styles['count']}>
          {localize('aiDebug.count', '{0} requests', { 0: records.length })}
        </span>
        <button
          type="button"
          className={styles['toolButton']}
          data-testid="ai-debug-clear"
          onClick={() => void service.clearRecords()}
        >
          {localize('aiDebug.clear', 'Clear')}
        </button>
      </div>
      <div className={styles['body']}>
        <ul className={styles['list']}>
          {records.length === 0 && (
            <li className={styles['empty']} data-testid="ai-debug-empty">
              {localize('aiDebug.none', 'No AI requests recorded yet.')}
            </li>
          )}
          {records.map((r) => (
            <RecordRow
              key={r.id}
              record={r}
              selected={r.id === selectedId}
              onSelect={() => setSelectedId(r.id)}
            />
          ))}
        </ul>
        {selectedId && <RecordDetail id={selectedId} />}
      </div>
    </div>
  )
}

function RecordRow({
  record,
  selected,
  onSelect,
}: {
  record: AiDebugRecordSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li
      className={styles['row']}
      data-status={record.status}
      data-selected={selected ? 'true' : undefined}
      data-testid="ai-debug-row"
      onClick={onSelect}
      title={record.modelId}
    >
      <span className={styles['purpose']}>{record.purpose ?? 'unknown'}</span>
      <span className={styles['model']}>{bareModel(record.modelId)}</span>
      <span className={styles['preview']}>{record.responsePreview}</span>
      <span className={styles['meta']}>
        {record.durationMs !== undefined ? `${record.durationMs}ms` : ''}
        {record.tokens ? ` · ${record.tokens.inputTokens}→${record.tokens.outputTokens}` : ''}
      </span>
      <span className={styles['badge']} data-status={record.status} aria-hidden="true">
        {statusLetter(record.status)}
      </span>
    </li>
  )
}

function RecordDetail({ id }: { id: string }) {
  const service = useService(IAiDebugService)
  const [record, setRecord] = useState<AiDebugRecord | undefined>(undefined)
  const [replayText, setReplayText] = useState<string | undefined>(undefined)
  const replayIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    setReplayText(undefined)
    replayIdRef.current = undefined
    let active = true
    void service.getRecord(id).then((r) => {
      if (active) setRecord(r)
    })
    return () => {
      active = false
    }
  }, [service, id])

  useEffect(() => {
    const subChunk = service.onDidReplayChunk((e) => {
      if (e.replayId !== replayIdRef.current) return
      setReplayText((prev) => (prev ?? '') + chunkText(e.chunk))
    })
    const subEnd = service.onDidReplayEnd(() => {
      // Keep the accumulated replay text; nothing else to do.
    })
    return () => {
      subChunk.dispose()
      subEnd.dispose()
    }
  }, [service])

  const replay = useCallback(
    (realtime: boolean) => {
      setReplayText('')
      void service.replayRecord(id, { realtime }).then((replayId) => {
        replayIdRef.current = replayId
      })
    },
    [service, id],
  )

  if (!record) return <div className={styles['detail']} />

  return (
    <div className={styles['detail']} data-testid="ai-debug-detail">
      <div className={styles['detailActions']}>
        <button
          type="button"
          className={styles['toolButton']}
          data-testid="ai-debug-replay"
          onClick={() => replay(false)}
        >
          {localize('aiDebug.replay', 'Replay')}
        </button>
        <button type="button" className={styles['toolButton']} onClick={() => replay(true)}>
          {localize('aiDebug.replayRealtime', 'Replay (realtime)')}
        </button>
        <button
          type="button"
          className={styles['toolButton']}
          onClick={() => void navigator.clipboard?.writeText(JSON.stringify(record, null, 2))}
        >
          {localize('aiDebug.copyJson', 'Copy JSON')}
        </button>
      </div>

      <Section title={localize('aiDebug.section.meta', 'Request')}>
        <dl className={styles['kv']}>
          <dt>{localize('aiDebug.meta.modelId', 'modelId')}</dt>
          <dd>{record.modelId}</dd>
          <dt>{localize('aiDebug.meta.status', 'status')}</dt>
          <dd>{record.status}</dd>
          {record.durationMs !== undefined && (
            <>
              <dt>{localize('aiDebug.meta.duration', 'duration')}</dt>
              <dd>{record.durationMs}ms</dd>
            </>
          )}
          {record.usage && (
            <>
              <dt>{localize('aiDebug.meta.tokens', 'tokens')}</dt>
              <dd>
                {record.usage.inputTokens}→{record.usage.outputTokens}
              </dd>
            </>
          )}
        </dl>
      </Section>

      <Section title={localize('aiDebug.section.prompt', 'Prompt')}>
        {record.messages.map((m, i) => (
          <pre key={i} className={styles['message']} data-role={m.role}>
            <span className={styles['roleTag']}>{roleLabel(m.role)}</span>
            {m.text}
          </pre>
        ))}
      </Section>

      <Section title={localize('aiDebug.section.response', 'Response')}>
        <pre className={styles['message']}>{record.responseText}</pre>
      </Section>

      {record.error && (
        <Section title={localize('aiDebug.section.error', 'Error')}>
          <pre className={styles['error']}>{record.error.message ?? record.error.name}</pre>
        </Section>
      )}

      {replayText !== undefined && (
        <Section title={localize('aiDebug.section.replay', 'Replay output')}>
          <pre className={styles['message']} data-testid="ai-debug-replay-output">
            {replayText}
          </pre>
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={styles['detailSection']}>
      <h3 className={styles['detailTitle']}>{title}</h3>
      {children}
    </section>
  )
}

function chunkText(chunk: AiResponseChunk): string {
  return chunk.type === 'text' ? chunk.value : ''
}

function bareModel(modelId: string): string {
  const parts = modelId.split('/')
  return parts[parts.length - 1] ?? modelId
}

function roleLabel(role: number): string {
  return role === 0 ? 'system' : role === 1 ? 'user' : 'assistant'
}

function statusLetter(status: AiDebugRecordSummary['status']): string {
  switch (status) {
    case 'ok':
      return '✓'
    case 'error':
      return '!'
    case 'canceled':
      return '⊘'
    default:
      return '…'
  }
}
