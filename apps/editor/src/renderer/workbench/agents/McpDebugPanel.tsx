/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpDebugPanel — the MCP tool replay debugger tab.
 *
 *  Renders whatever the debug service holds for this tab's key and calls back into
 *  it for every action; it owns no state of its own beyond the copy-button flash.
 *  That split matters: the panel is unmounted by a tab switch, and the connection,
 *  the tool list and the call history must survive that.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Play, Plug, RefreshCw, Trash2, Unplug } from 'lucide-react'
import { IEditorInput, localize, type IObservable } from '@universe-editor/platform'
import { Button, IconButton, cx } from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { IMcpDebugService } from '../../services/acp/mcp/mcpDebugService.js'
import { McpDebugEditorInput } from '../../services/acp/mcp/mcpDebugEditorInput.js'
import {
  parseParamsText,
  prettyJson,
  type McpDebugCallEntry,
  type McpDebugConnectionState,
  type McpDebugPanelState,
} from '../../services/acp/mcp/mcpDebugModel.js'
import type { McpCallResultDto } from '../../../shared/ipc/mcpClientService.js'
import styles from './McpDebugPanel.module.css'

const TESTID = 'mcp-debug-panel'

export function McpDebugPanel({ input }: { input: IEditorInput }) {
  const service = useService(IMcpDebugService)
  if (!(input instanceof McpDebugEditorInput)) return null
  const source = service.getState(input.key)
  if (source === undefined) {
    // The tab outlived its state (the service released it on close, or this input
    // was restored by something else). Nothing to drive — say so instead of
    // rendering an empty shell that looks like a hung connection.
    return (
      <div className={styles.panel} data-testid={TESTID}>
        <div className={styles.placeholder}>
          {localize('mcpDebug.panel.noState', 'This debugger tab has no live session.')}
        </div>
      </div>
    )
  }
  return <PanelBody service={service} source={source} />
}

function PanelBody({
  service,
  source,
}: {
  service: IMcpDebugService
  source: IObservable<McpDebugPanelState>
}) {
  const state = useObservable(source)
  const key = state.key
  const parsed = parseParamsText(state.paramsText)
  const selected = state.tools.find((tool) => tool.name === state.selectedTool)
  const connected = state.connection === 'connected'

  return (
    <div className={styles.panel} data-testid={TESTID}>
      <header className={styles.header}>
        <Plug size={14} className={styles.headerIcon} />
        <span className={styles.serverName} title={`${state.targetSummary}`}>
          {state.serverName}
        </span>
        <span className={styles.transport}>{state.transport}</span>
        <span
          className={cx(styles.status, styles[state.connection])}
          data-testid={`${TESTID}-connection-state`}
          data-state={state.connection}
        >
          {connectionLabel(state.connection)}
        </span>
        {state.serverVersion !== undefined && (
          <span className={styles.version}>{state.serverVersion}</span>
        )}
        <div className={styles.headerSpacer} />
        <IconButton
          label={localize('mcpDebug.panel.refreshTools', 'Refresh tools')}
          size={22}
          disabled={!connected}
          data-testid={`${TESTID}-refresh-tools`}
          onClick={() => void service.refreshTools(key)}
        >
          <RefreshCw size={14} />
        </IconButton>
        <IconButton
          label={localize('mcpDebug.panel.disconnect', 'Disconnect')}
          size={22}
          disabled={!connected}
          data-testid={`${TESTID}-disconnect`}
          onClick={() => void service.disconnect(key)}
        >
          <Unplug size={14} />
        </IconButton>
      </header>

      {state.warning !== undefined && (
        <div className={styles.warning} data-testid={`${TESTID}-warning-banner`}>
          <AlertTriangle size={13} />
          <span>{state.warning}</span>
        </div>
      )}

      {state.connectionError !== undefined && (
        <ErrorBanner
          testId={`${TESTID}-connect-error`}
          message={state.connectionError}
          details={state.targetSummary}
        />
      )}

      {state.instructions !== undefined && state.instructions.length > 0 && (
        <div className={styles.instructions}>{state.instructions}</div>
      )}

      <div className={styles.columns}>
        <aside className={styles.toolColumn}>
          <div className={styles.sectionTitle}>
            {localize('mcpDebug.panel.tools', 'Tools ({count})', {
              count: state.tools.length,
            })}
          </div>
          <div className={styles.toolList}>
            {state.tools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                className={cx(
                  styles.toolRow,
                  tool.name === state.selectedTool && styles.toolRowActive,
                )}
                data-testid={`${TESTID}-tool-row`}
                data-tool-name={tool.name}
                data-active={tool.name === state.selectedTool}
                title={tool.description ?? tool.name}
                onClick={() => service.selectTool(key, tool.name)}
              >
                {tool.title ?? tool.name}
              </button>
            ))}
            {state.tools.length === 0 && (
              <div className={styles.emptyHint}>
                {localize('mcpDebug.panel.noTools', 'This server exposes no tools.')}
              </div>
            )}
          </div>
          {state.toolsError !== undefined && (
            <div className={styles.toolsError}>{state.toolsError}</div>
          )}
        </aside>

        <main className={styles.callColumn}>
          <div className={styles.sectionTitle}>
            {selected === undefined
              ? localize('mcpDebug.panel.noSelection', 'No tool selected')
              : (selected.title ?? selected.name)}
          </div>
          {selected?.description !== undefined && (
            <div className={styles.description}>{selected.description}</div>
          )}
          <pre className={styles.schema} data-testid={`${TESTID}-tool-schema`}>
            {selected === undefined ? '' : prettyJson(selected.inputSchema)}
          </pre>

          <div className={styles.sectionTitle}>
            {localize('mcpDebug.panel.arguments', 'Arguments (JSON)')}
          </div>
          <textarea
            className={cx(styles.params, !parsed.ok && styles.paramsInvalid)}
            data-testid={`${TESTID}-params-input`}
            spellCheck={false}
            value={state.paramsText}
            onChange={(event) => service.setParamsText(key, event.target.value)}
          />
          {!parsed.ok && (
            <div className={styles.paramsError} data-testid={`${TESTID}-params-error`}>
              {parsed.message}
            </div>
          )}
          <div className={styles.runRow}>
            <Button
              variant="primary"
              size="sm"
              busy={state.running}
              disabled={!parsed.ok}
              data-testid={`${TESTID}-call`}
              onClick={() => void service.runTool(key)}
            >
              <Play size={13} />
              {localize('mcpDebug.panel.run', 'Run Tool')}
            </Button>
          </div>

          {state.lastError !== undefined && (
            <ErrorBanner
              testId={`${TESTID}-error`}
              message={state.lastError}
              details={[state.targetSummary, state.lastError].join('\n')}
            />
          )}
          {state.lastResult !== undefined && <ResultBlock result={state.lastResult} />}
        </main>
      </div>

      <HistorySection service={service} state={state} />
    </div>
  )
}

function ResultBlock({ result }: { result: McpCallResultDto }) {
  return (
    <div
      className={cx(styles.result, result.isError && styles.resultError)}
      data-testid={`${TESTID}-response`}
      data-is-error={result.isError}
    >
      <div className={styles.resultHead}>
        <span>
          {result.isError
            ? localize('mcpDebug.panel.serverError', 'The server reported an error')
            : localize('mcpDebug.panel.serverReply', 'Server reply')}
        </span>
        <span className={styles.duration}>{result.durationMs} ms</span>
      </div>
      {result.isError && (
        <div className={styles.resultNote}>
          {localize(
            'mcpDebug.panel.isErrorNote',
            'This is the server’s own reply, not an editor failure.',
          )}
        </div>
      )}
      <pre className={styles.json}>{prettyJson(result.content)}</pre>
      {result.structuredContent !== undefined && (
        <>
          <div className={styles.sectionTitle}>
            {localize('mcpDebug.panel.structuredContent', 'Structured content')}
          </div>
          <pre className={styles.json}>{prettyJson(result.structuredContent)}</pre>
        </>
      )}
    </div>
  )
}

function ErrorBanner({
  testId,
  message,
  details,
}: {
  testId: string
  message: string
  details: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(details)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Best-effort, same as CodeBlock: leave the button idle on failure.
    }
  }, [details])

  return (
    <div className={styles.error} data-testid={testId}>
      <AlertTriangle size={13} className={styles.errorIcon} />
      <span className={styles.errorText}>{message}</span>
      <Button size="sm" variant="ghost" onClick={() => void onCopy()}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied
          ? localize('mcpDebug.panel.copied', 'Copied')
          : localize('mcpDebug.panel.copyDetails', 'Copy details')}
      </Button>
    </div>
  )
}

function HistorySection({
  service,
  state,
}: {
  service: IMcpDebugService
  state: McpDebugPanelState
}) {
  return (
    <footer className={styles.history}>
      <div className={styles.historyHead}>
        <span className={styles.sectionTitle}>
          {localize('mcpDebug.panel.history', 'History ({count})', {
            count: state.history.length,
          })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={state.history.length === 0}
          data-testid={`${TESTID}-history-clear`}
          onClick={() => service.clearHistory(state.key)}
        >
          <Trash2 size={12} />
          {localize('mcpDebug.panel.clearHistory', 'Clear')}
        </Button>
      </div>
      <div className={styles.historyList}>
        {state.history.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            onRestore={() => service.restore(state.key, entry.id)}
          />
        ))}
        {state.history.length === 0 && (
          <div className={styles.emptyHint}>
            {localize('mcpDebug.panel.noHistory', 'No calls yet.')}
          </div>
        )}
      </div>
    </footer>
  )
}

function HistoryRow({ entry, onRestore }: { entry: McpDebugCallEntry; onRestore: () => void }) {
  return (
    <details className={styles.historyRow} data-testid={`${TESTID}-history-row`}>
      <summary className={styles.historySummary}>
        <span className={cx(styles.historyTool, entry.isError && styles.historyToolError)}>
          {entry.tool}
        </span>
        <span className={styles.duration}>{entry.durationMs} ms</span>
        <span className={styles.historyTime}>{formatTime(entry.startedAt)}</span>
      </summary>
      <div className={styles.historyBody}>
        <div className={styles.sectionTitle}>
          {localize('mcpDebug.panel.arguments', 'Arguments (JSON)')}
        </div>
        <pre className={styles.json}>{entry.paramsText}</pre>
        <div className={styles.sectionTitle}>
          {entry.error !== undefined
            ? localize('mcpDebug.panel.errorTitle', 'Error')
            : localize('mcpDebug.panel.response', 'Response')}
        </div>
        <pre className={cx(styles.json, entry.isError && styles.jsonError)}>
          {entry.error ?? prettyJson(entry.result?.content)}
        </pre>
        <Button size="sm" variant="ghost" onClick={onRestore}>
          {localize('mcpDebug.panel.restore', 'Put back in the editor')}
        </Button>
      </div>
    </details>
  )
}

function connectionLabel(state: McpDebugConnectionState): string {
  switch (state) {
    case 'idle':
      return localize('mcpDebug.conn.idle', 'Not connected')
    case 'connecting':
      return localize('mcpDebug.conn.connecting', 'Connecting…')
    case 'connected':
      return localize('mcpDebug.conn.connected', 'Connected')
    case 'failed':
      return localize('mcpDebug.conn.failed', 'Connection failed')
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}
