/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiTitleBarButton — the AI quick-settings entry, moved from the status bar to
 *  the title bar (right of the running-session pill). Renders a sparkle button
 *  and, on click, a downward-anchored quick-settings popover (inline-completion
 *  toggle, shortcuts to the Agents view / AI settings, and per-feature model
 *  rows). The tooltip carries the active session's MCP server summary.
 *
 *  The AI services are Promise+Event based (not observables), so we pull data in an
 *  effect and refresh on their change events rather than using useObservable.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AiQuickSettingsPanel,
  FocusScopeOverlay,
  type AiSlotKey,
  type AiSlotRow,
} from '@universe-editor/workbench-ui'
import {
  IAiModelService,
  ICommandService,
  constObservable,
  derived,
  localize,
  type AiModelMetadata,
} from '@universe-editor/platform'
import { Bot, Settings, Sparkles } from 'lucide-react'
import { useObservable, useOptionalService, useService } from '../useService.js'
import { IInlineCompletionService } from '../../services/ai/InlineCompletionService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import styles from './TitleBar.module.css'

const GAP = 6

const PICK_MODEL_COMMANDS: Record<AiSlotKey, string> = {
  chat: 'ai.pickModel',
  inline: 'ai.inlineCompletion.pickModel',
  commit: 'ai.commitMessage.pickModel',
  sessionTitle: 'ai.sessionTitle.pickModel',
}

interface AiSnapshot {
  models: readonly AiModelMetadata[]
  chat?: string | undefined
  inline?: string | undefined
  commit?: string | undefined
  sessionTitle?: string | undefined
}

const EMPTY: AiSnapshot = { models: [] }
const NO_SERVERS: readonly { status: string }[] = []

function renderIcon(id: 'agents' | 'settings') {
  switch (id) {
    case 'agents':
      return <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
    case 'settings':
      return <Settings size={14} strokeWidth={1.75} aria-hidden="true" />
  }
}

/** Single-line MCP status summary appended to the AI tooltip. */
function mcpTooltip(base: string, servers: readonly { status: string }[]): string {
  if (servers.length === 0) return base
  const connected = servers.filter((s) => s.status === 'connected').length
  const summary = `MCP ${connected}/${servers.length} connected`
  const failed = servers.filter((s) => s.status !== 'connected' && s.status !== 'pending').length
  return failed > 0 ? `${base} · ${summary}, ${failed} failed` : `${base} · ${summary}`
}

export function AiTitleBarButton() {
  const ai = useService(IAiModelService)
  const inline = useService(IInlineCompletionService)
  const commands = useService(ICommandService)
  const sessionsService = useOptionalService(IAcpSessionService)

  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [snapshot, setSnapshot] = useState<AiSnapshot>(EMPTY)
  const [inlineEnabled, setInlineEnabled] = useState(inline.enabled)

  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const [models, chat, inlineModel, commit, sessionTitle] = await Promise.all([
      ai.getModels(),
      ai.getActiveModelId(),
      ai.getInlineCompletionModelId(),
      ai.getCommitModelId(),
      ai.getSessionTitleModelId(),
    ])
    return { models, chat, inline: inlineModel, commit, sessionTitle }
  }, [ai])

  useEffect(() => {
    let alive = true
    const apply = () => {
      void refresh().then((s) => {
        if (alive) setSnapshot(s)
      })
      setInlineEnabled(inline.enabled)
    }
    apply()
    const disposables = [
      ai.onDidChangeModels(apply),
      ai.onDidChangeActiveModel(apply),
      ai.onDidChangeInlineCompletionModel(apply),
      ai.onDidChangeCommitModel(apply),
      ai.onDidChangeSessionTitleModel(apply),
      inline.onDidChange(apply),
    ]
    return () => {
      alive = false
      for (const d of disposables) d.dispose()
    }
  }, [ai, inline, refresh])

  const mcpServersObs = useMemo(
    () =>
      sessionsService
        ? derived(
            /**
             * @description titlebar.aiButton.mcpServers
             */
            (r) => sessionsService.activeSession.read(r)?.mcpServers.read(r) ?? NO_SERVERS,
          )
        : constObservable<readonly { status: string }[]>(NO_SERVERS),
    [sessionsService],
  )
  const mcpServers = useObservable(mcpServersObs)
  const tooltip = mcpTooltip(localize('ai.statusbar.tooltip', 'AI'), mcpServers)

  // Close on click-outside (FocusScopeOverlay only handles Escape + focus trap).
  useEffect(() => {
    if (!open) return
    const onMousedown = (e: MouseEvent) => {
      const target = e.target as Node
      if (popRef.current?.contains(target)) return
      if (btnRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMousedown)
    return () => document.removeEventListener('mousedown', onMousedown)
  }, [open])

  const toggleOpen = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setRect(r)
    setOpen((o) => !o)
  }

  const modelName = (id: string | undefined): string | undefined =>
    id ? snapshot.models.find((m) => m.id === id)?.name : undefined

  const rows: readonly AiSlotRow[] = [
    {
      key: 'chat',
      label: localize('ai.quickSettings.chat', 'Chat'),
      currentModelName: modelName(snapshot.chat),
    },
    {
      key: 'inline',
      label: localize('ai.quickSettings.inline', 'Inline'),
      currentModelName: modelName(snapshot.inline),
    },
    {
      key: 'commit',
      label: localize('ai.quickSettings.commit', 'Commit'),
      currentModelName: modelName(snapshot.commit),
    },
    {
      key: 'sessionTitle',
      label: localize('ai.quickSettings.sessionTitle', 'Session Title'),
      currentModelName: modelName(snapshot.sessionTitle),
    },
  ]

  const onPickModel = (slot: AiSlotKey) => {
    void commands.executeCommand(PICK_MODEL_COMMANDS[slot])
    setOpen(false)
  }

  const panel =
    open && rect
      ? createPortal(
          <FocusScopeOverlay visible onEscape={() => setOpen(false)}>
            <div
              ref={popRef}
              style={{
                position: 'fixed',
                top: rect.bottom + GAP,
                right: Math.max(GAP, window.innerWidth - rect.right),
                zIndex: 1000,
              }}
            >
              <AiQuickSettingsPanel
                title={localize('ai.quickSettings.title', 'AI Settings')}
                inlineLabel={localize('ai.quickSettings.inlineCompletions', 'Inline Completions')}
                inlineEnabled={inlineEnabled}
                onToggleInline={(b) => inline.setEnabled(b)}
                openAgentsLabel={localize('ai.quickSettings.openAgents', 'Open Agents')}
                onOpenAgents={() => {
                  void commands.executeCommand('workbench.action.agent.openView')
                  setOpen(false)
                }}
                openSettingsLabel={localize('ai.quickSettings.manageModels', 'Manage AI Models')}
                onOpenAiSettings={() => {
                  void commands.executeCommand('ai.manageModels')
                  setOpen(false)
                }}
                rows={rows}
                noModelLabel={localize('ai.quickSettings.noModel', 'Select model…')}
                onPickModel={onPickModel}
                renderIcon={renderIcon}
              />
            </div>
          </FocusScopeOverlay>,
          document.body,
        )
      : null

  return (
    <>
      <button
        ref={btnRef}
        className={styles['ai-button']}
        onClick={toggleOpen}
        title={tooltip}
        aria-label={tooltip}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="titlebar-ai-button"
      >
        <Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {panel}
    </>
  )
}
