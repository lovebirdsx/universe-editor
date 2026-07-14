/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ToolCallCard / ToolCallList — renders the tool-call lane below the chat log.
 *
 *  Body rendering branches on `call.kind`:
 *   - `read` / `search` → whole body collapsed by default; click header to expand.
 *   - `execute` → command output rendered as an ANSI-coloured terminal with a
 *                 height cap + expand toggle.
 *   - other     → inline diff previews + markdown blocks (default behaviour).
 *--------------------------------------------------------------------------------------------*/

import { memo, useState, type ReactNode } from 'react'
import { IConfigurationService, IEditorService, URI, localize } from '@universe-editor/platform'
import { useObservable, useService } from '../useService.js'
import type {
  AcpMessage,
  AcpToolCall,
  AcpToolCallDiff,
  IAcpSession,
} from '../../services/acp/acpSessionService.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { InlineDiffPreview } from './InlineDiffPreview.js'
import { CodeBlock } from './CodeBlock.js'
import { MessageContent } from './MessageContent.js'
import { TerminalOutput, ToolCallSection, ToolCallStatusIcon } from './ToolCallOutput.js'
import { deriveToolCallDisplay, tryPrettyJson } from './toolCallDisplay.js'
import { toolKindIcon } from './timelineIcons.js'
import { buildStickyKey } from './stickyScroll.js'
import { resolveCollapsed, type CollapseState } from './timelineCollapse.js'
import styles from './agents.module.css'

/** Config key controlling which MCP-card sections start expanded. */
const MCP_CARD_DEFAULT_EXPANDED = 'acp.mcpCard.defaultExpanded'
type McpExpandMode = 'both' | 'output' | 'none'

function readMcpExpand(mode: string | undefined): { input: boolean; output: boolean } {
  const m: McpExpandMode = mode === 'output' || mode === 'none' ? mode : 'both'
  return { input: m === 'both', output: m === 'both' || m === 'output' }
}

/** Non-empty object → pretty-printed JSON string for the MCP input panel. */
function formatMcpInput(rawInput: unknown): string | undefined {
  if (typeof rawInput !== 'object' || rawInput === null) return undefined
  if (Object.keys(rawInput as Record<string, unknown>).length === 0) return undefined
  try {
    return JSON.stringify(rawInput, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Threads the unified collapse store into a controlled tool-call subtree so the
 * sticky overlay (and Alt+F) can fold nested sub-agent cards via composite keys.
 * Absent for the standalone {@link ToolCallList}, which keeps self-managed state.
 */
export interface SubtreeCollapse {
  /** This card's own (composite) sticky key. */
  readonly stickyKey: string
  /** This card's own nesting depth. */
  readonly depth: number
  readonly collapse: CollapseState
  readonly toggle: (key: string) => void
}

export function ToolCallList({ session }: { session: IAcpSession }) {
  const calls = useObservable(session.toolCalls)
  if (calls.length === 0) return null
  return (
    <ul className={styles['toolCallList']} data-testid="acp-toolcall-list">
      {calls.map((c) => (
        <ToolCallCard key={c.id} call={c} />
      ))}
    </ul>
  )
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  extraClassName,
  dataTimelineKey,
  dataStickyKey,
  dataStickyDepth,
  collapsed: collapsedProp,
  onToggleCollapse,
  subtreeCollapse,
  badge,
}: {
  call: AcpToolCall
  extraClassName?: string
  dataTimelineKey?: string
  dataStickyKey?: string
  dataStickyDepth?: number
  collapsed?: boolean
  onToggleCollapse?: () => void
  subtreeCollapse?: SubtreeCollapse
  badge?: ReactNode
}) {
  const editorService = useService(IEditorService)
  const configService = useService(IConfigurationService)
  const isMcp = call.mcpServer !== undefined
  // Controlled by the timeline (Alt+F / Ctrl+Alt+F); falls back to self-managed
  // state when used standalone (ToolCallList). read/search start collapsed, but
  // MCP cards start expanded so their input/output panels are visible.
  const controlled = collapsedProp !== undefined
  const [internalCollapsed, setInternalCollapsed] = useState(
    () => !isMcp && (call.kind === 'read' || call.kind === 'search'),
  )
  const collapsed = controlled ? collapsedProp : internalCollapsed
  const onToggle = controlled
    ? (onToggleCollapse ?? (() => {}))
    : () => setInternalCollapsed((v) => !v)

  const openDiff = (diff: AcpToolCallDiff): void => {
    const uri = diff.path.includes('://') ? URI.parse(diff.path) : URI.file(diff.path)
    // Only local files can be reopened as a source file from the diff title bar.
    const openable = uri.scheme === 'file' ? uri : undefined
    void editorService.openEditor(
      new DiffEditorInput(uri, diff.oldText, diff.newText, undefined, openable),
    )
  }

  const className = extraClassName
    ? `${styles['toolCallCard']} ${extraClassName}`
    : styles['toolCallCard']

  const hasDiffs = call.diffs.length > 0
  const isExecute = call.kind === 'execute'
  const display = deriveToolCallDisplay(call)

  const diffs = hasDiffs && (
    <div className={styles['toolCallDiffs']}>
      {call.diffs.map((d, i) => (
        <InlineDiffPreview
          key={`${d.path}-${i}`}
          path={d.path}
          oldText={d.oldText}
          newText={d.newText}
          onOpen={() => openDiff(d)}
        />
      ))}
    </div>
  )

  const commandDetail = display.subtitle !== undefined && (
    <div className={styles['toolCallCommand']}>
      <code>{display.subtitle}</code>
    </div>
  )

  const mcpBody =
    isMcp &&
    (() => {
      const expand = readMcpExpand(configService.get<string>(MCP_CARD_DEFAULT_EXPANDED))
      const inputJson = formatMcpInput(call.rawInput)
      // Output is plain text unless the agent embedded images/resources; in the
      // text case try to pretty-print JSON for a highlighted, readable panel.
      const textOnlyOutput = call.blocks.every((b) => b.type === 'text')
      const outputJson = textOnlyOutput ? tryPrettyJson(call.text) : undefined
      const hasOutput = outputJson !== undefined || call.blocks.length > 0
      return (
        <>
          {diffs}
          {inputJson !== undefined && (
            <ToolCallSection
              label={localize('acp.mcp.input', 'Input')}
              defaultExpanded={expand.input}
              testId="acp-mcp-input"
            >
              <CodeBlock code={inputJson} lang="json" />
            </ToolCallSection>
          )}
          {hasOutput && (
            <ToolCallSection
              label={localize('acp.mcp.output', 'Output')}
              defaultExpanded={expand.output}
              testId="acp-mcp-output"
            >
              {outputJson !== undefined ? (
                <CodeBlock code={outputJson} lang="json" />
              ) : (
                <MessageContent blocks={call.blocks} />
              )}
            </ToolCallSection>
          )}
        </>
      )
    })()

  const body = isMcp ? (
    mcpBody
  ) : isExecute ? (
    <>
      {diffs}
      {commandDetail}
      {call.text.length > 0 && (
        <div className={styles['toolCallBody']}>
          <TerminalOutput
            text={call.text}
            {...(dataStickyKey !== undefined ? { contentKey: `term:${dataStickyKey}` } : {})}
          />
        </div>
      )}
    </>
  ) : (
    <>
      {diffs}
      {commandDetail}
      {call.blocks.length > 0 && (
        <div className={styles['toolCallBody']}>
          <MessageContent blocks={call.blocks} />
        </div>
      )}
    </>
  )

  // Sub-agent timeline (Task tool): the spawned agent's messages / tool calls,
  // folded inside this card. CollapsibleSlot only mounts the body when expanded,
  // so this stays hidden until the user opens the card.
  const children = call.children ?? []
  const childTimeline = children.length > 0 && (
    <ul className={styles['toolCallChildren']} data-testid="acp-subagent-timeline">
      {children.map((c) => {
        if (c.kind === 'message') return <SubMessage key={c.id} message={c.message} />
        if (!subtreeCollapse) return <ToolCallCard key={c.id} call={c.call} />
        const childKey = buildStickyKey(subtreeCollapse.stickyKey, c)
        const childDepth = subtreeCollapse.depth + 1
        return (
          <ToolCallCard
            key={c.id}
            call={c.call}
            collapsed={resolveCollapsed(childKey, c, subtreeCollapse.collapse)}
            onToggleCollapse={() => subtreeCollapse.toggle(childKey)}
            subtreeCollapse={{
              stickyKey: childKey,
              depth: childDepth,
              collapse: subtreeCollapse.collapse,
              toggle: subtreeCollapse.toggle,
            }}
            dataStickyKey={childKey}
            dataStickyDepth={childDepth}
          />
        )
      })}
    </ul>
  )

  const titleNode = (
    <span className={styles['toolCallTitle']}>
      {display.title}
      {call.mcpServer !== undefined && (
        <span
          className={styles['mcpBadge']}
          title={call.mcpTool !== undefined ? `${call.mcpServer} · ${call.mcpTool}` : call.title}
        >
          MCP · {call.mcpServer}
        </span>
      )}
    </span>
  )

  return (
    <CollapsibleSlot
      as="li"
      icon={toolKindIcon(call.kind)}
      kindLabel={call.kind}
      title={titleNode}
      summary={titleNode}
      statusIcon={<ToolCallStatusIcon status={call.status} />}
      {...(badge !== undefined ? { badge } : {})}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{
        className,
        'data-status': call.status,
        'data-kind': call.kind,
        ...(dataTimelineKey !== undefined ? { 'data-timeline-key': dataTimelineKey } : {}),
        ...(dataStickyKey !== undefined ? { 'data-sticky-key': dataStickyKey } : {}),
        ...(dataStickyDepth !== undefined ? { 'data-sticky-depth': String(dataStickyDepth) } : {}),
      }}
    >
      {body}
      {childTimeline}
    </CollapsibleSlot>
  )
})

/** A single sub-agent message rendered inside a parent tool call's child timeline. */
function SubMessage({ message }: { message: AcpMessage }) {
  return (
    <li
      className={styles['subMessage']}
      data-role={message.role}
      data-testid="acp-subagent-message"
    >
      <MessageContent blocks={message.blocks} />
    </li>
  )
}
