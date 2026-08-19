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
import {
  IConfigurationService,
  IEditorService,
  IInstantiationService,
  IWorkspaceService,
  REMOTE_SCHEME,
  URI,
  absolutePathToWorkspaceUri,
  localize,
} from '@universe-editor/platform'
import { useObservable, useOptionalService, useService } from '../useService.js'
import type {
  AcpMessage,
  AcpToolCall,
  AcpToolCallDiff,
  AcpToolCallLocation,
  IAcpSession,
} from '../../services/acp/session/acpSessionService.js'
import {
  firstLineSummary,
  hasVisibleMessageContent,
  memoryTrimmedNotice,
} from '../../services/acp/session/acpSession.js'
import { DiffEditorInput } from '../../services/editor/DiffEditorInput.js'
import { useMarkdownFileLink } from '../markdown/useMarkdownFileLink.js'
import { CollapsibleSlot } from '@universe-editor/workbench-ui'
import { InlineDiffPreview } from './InlineDiffPreview.js'
import { ToolCallLocations } from './ToolCallLocations.js'
import { CodeBlock } from './CodeBlock.js'
import { MessageContent } from './MessageContent.js'
import { TerminalOutput, ToolCallSection, ToolCallStatusIcon } from './ToolCallOutput.js'
import { SubagentStatsBadge } from './SubagentStatsBadge.js'
import {
  deriveToolCallDisplay,
  isKeepPlanning,
  keepPlanningFeedback,
  tryPrettyJson,
} from './toolCallDisplay.js'
import { roleIcon, toolKindIcon } from './timelineIcons.js'
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
  /** Live keyboard-focused slot key — matched against each child's composite key
   *  to render the focus ring on the focused sub-agent item. */
  readonly focusedKey?: string | null
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
  const workspaceService = useOptionalService(IWorkspaceService)
  const inst = useService(IInstantiationService)
  // Reuse the same file opener the markdown renderer / code blocks use, so a path
  // on a tool-call card resolves (absolute / relative to workspace) and reveals
  // its line exactly like a path clicked anywhere else in the chat.
  const openFilePath = useMarkdownFileLink(workspaceService?.current?.folder)
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
    const uri = diff.path.includes('://')
      ? URI.parse(diff.path)
      : absolutePathToWorkspaceUri(diff.path, workspaceService?.current?.folder)
    // Local and remote workspace files can both be reopened as a source file
    // from the diff title bar; only non-file schemes are left closed.
    const openable = uri.scheme === 'file' || uri.scheme === REMOTE_SCHEME ? uri : undefined
    void editorService.openEditor(
      inst.createInstance(
        DiffEditorInput,
        uri,
        diff.oldText,
        diff.newText,
        undefined,
        openable,
        false,
      ),
    )
  }

  const className = extraClassName
    ? `${styles['toolCallCard']} ${extraClassName}`
    : styles['toolCallCard']

  const hasDiffs = call.diffs.length > 0
  const isExecute = call.kind === 'execute'
  const display = deriveToolCallDisplay(call)
  // "继续规划"是正常流程而非错误：把红色失败态降级为中性完成态，并抑制那句给模型看的
  // 内部拒绝文案（body）。若用户在 steering 输入框写下了意见，则改为把该意见作为「你的
  // 反馈」展示出来——这也是回放时该意见的唯一可见来源。
  const keepPlanning = isKeepPlanning(call)
  const effectiveStatus = keepPlanning ? 'completed' : call.status
  const steerFeedback = keepPlanningFeedback(call)

  const diffs = hasDiffs && (
    <div className={styles['toolCallDiffs']}>
      {call.diffs.map((d, i) => (
        <InlineDiffPreview
          key={`${d.path}-${i}`}
          path={d.path}
          oldText={d.oldText}
          newText={d.newText}
          onOpen={() => openDiff(d)}
          onOpenPath={() => openFilePath(d.path)}
        />
      ))}
    </div>
  )

  // Cards that touched files but carry no diff (read / search / memory) surface
  // their affected paths as clickable links so the file opens just like a path
  // clicked in prose. Diff cards already show the path in the diff header, so
  // skip the row there to avoid duplicating it.
  const locations = !hasDiffs && !isMcp && call.locations !== undefined && (
    <ToolCallLocations
      locations={call.locations}
      onOpen={(loc: AcpToolCallLocation) => openFilePath(loc.path, loc.line)}
    />
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
      {locations}
      {commandDetail}
      {keepPlanning
        ? steerFeedback !== undefined && (
            <div className={styles['toolCallFeedback']} data-testid="acp-keep-planning-feedback">
              <span className={styles['toolCallFeedbackLabel']}>
                {localize('acp.switchMode.feedbackLabel', 'Your feedback')}
              </span>
              <span>{steerFeedback}</span>
            </div>
          )
        : call.blocks.length > 0 && (
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
        // Standalone (ToolCallList) usage has no shared collapse/focus store —
        // children render bare, without sticky keys or focus rings.
        if (!subtreeCollapse) {
          if (c.kind === 'message') return <SubMessage key={c.id} message={c.message} />
          return <ToolCallCard key={c.id} call={c.call} />
        }
        const childKey = buildStickyKey(subtreeCollapse.stickyKey, c)
        const childFocused = subtreeCollapse.focusedKey === childKey
        const childDepth = subtreeCollapse.depth + 1
        if (c.kind === 'message') {
          return (
            <SubMessage
              key={c.id}
              message={c.message}
              stickyKey={childKey}
              focused={childFocused}
              collapsed={resolveCollapsed(childKey, c, subtreeCollapse.collapse)}
              onToggleCollapse={() => subtreeCollapse.toggle(childKey)}
              depth={childDepth}
            />
          )
        }
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
              ...(subtreeCollapse.focusedKey !== undefined
                ? { focusedKey: subtreeCollapse.focusedKey }
                : {}),
            }}
            dataStickyKey={childKey}
            dataStickyDepth={childDepth}
            {...(childFocused ? { extraClassName: styles['timelineSlotFocused'] ?? '' } : {})}
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
          data-tooltip={
            call.mcpTool !== undefined ? `${call.mcpServer} · ${call.mcpTool}` : call.title
          }
        >
          MCP · {call.mcpServer}
        </span>
      )}
      <SubagentStatsBadge call={call} />
    </span>
  )

  const trimmedNotice = call.memoryTrimmed && (
    <div className={styles['toolCallMemoryTrimmed']} data-testid="acp-toolcall-memory-trimmed">
      {memoryTrimmedNotice()}
    </div>
  )

  return (
    <CollapsibleSlot
      as="li"
      icon={toolKindIcon(call.kind)}
      kindLabel={call.kind}
      title={titleNode}
      summary={titleNode}
      statusIcon={<ToolCallStatusIcon status={effectiveStatus} />}
      {...(badge !== undefined ? { badge } : {})}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{
        className,
        'data-status': effectiveStatus,
        'data-kind': call.kind,
        ...(dataTimelineKey !== undefined ? { 'data-timeline-key': dataTimelineKey } : {}),
        ...(dataStickyKey !== undefined ? { 'data-sticky-key': dataStickyKey } : {}),
        ...(dataStickyDepth !== undefined ? { 'data-sticky-depth': String(dataStickyDepth) } : {}),
      }}
    >
      {call.memoryTrimmed ? trimmedNotice : body}
      {childTimeline}
    </CollapsibleSlot>
  )
})

/** A single sub-agent message rendered inside a parent tool call's child
 *  timeline. Card form matches the top-level message card: CollapsibleSlot
 *  shell + role icon + single-line summary, foldable like any other slot.
 *  Sub messages are always agent/thought (never user), and never stream. */
function SubMessage({
  message,
  stickyKey,
  focused,
  collapsed: collapsedProp,
  onToggleCollapse,
  depth,
}: {
  message: AcpMessage
  /** Composite sticky key — set when the card tree runs under the timeline's
   *  shared collapse/focus store (ChatBody), absent for ToolCallList. */
  stickyKey?: string
  focused?: boolean
  /** Controlled collapse from the shared store; absent in standalone ToolCallList. */
  collapsed?: boolean
  onToggleCollapse?: () => void
  /** Nesting depth for the sticky-scroll overlay indent (matches nested tool calls). */
  depth?: number
}) {
  // Controlled by the timeline (Alt+F / Ctrl+Alt+F); falls back to self-managed
  // state when used standalone (ToolCallList). Sub messages start expanded.
  const controlled = collapsedProp !== undefined
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  // Drop settled empty sub messages (no visible content) like the main timeline
  // does — a card with just an icon and no body would read as a rendering glitch.
  if (message.role !== 'user' && !hasVisibleMessageContent(message.blocks)) {
    return null
  }
  const collapsed = controlled ? collapsedProp : internalCollapsed
  const onToggle = controlled
    ? (onToggleCollapse ?? (() => {}))
    : () => setInternalCollapsed((v) => !v)

  const className =
    styles['messageItem'] + (focused ? ` ${styles['timelineSlotFocused'] ?? ''}` : '')
  return (
    <CollapsibleSlot
      icon={roleIcon(message.role)}
      kindLabel={message.role}
      summary={firstLineSummary(message.text)}
      collapsed={collapsed}
      onToggle={onToggle}
      rootProps={{
        className,
        'data-role': message.role,
        'data-testid': 'acp-subagent-message',
        ...(stickyKey !== undefined ? { 'data-sticky-key': stickyKey } : {}),
        ...(depth !== undefined ? { 'data-sticky-depth': String(depth) } : {}),
      }}
    >
      <MessageContent blocks={message.blocks} />
    </CollapsibleSlot>
  )
}
