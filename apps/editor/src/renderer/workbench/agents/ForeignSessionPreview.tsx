/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ForeignSessionPreview — read-only metadata view shown when the user clicks a
 *  session that belongs to a different worktree than the open folder. Resuming
 *  it here would spawn the agent against the session's own cwd while this
 *  window's views stay on the current folder (split-brain), so instead we show
 *  the session's metadata + its TRUE config (read from the owning worktree's
 *  storage bucket, not the current one) and offer to activate it in its own
 *  context. No agent process is spawned.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { Bot, GitBranch, Settings2, Sliders, Sparkles, SquareArrowOutUpRight } from 'lucide-react'
import {
  IStorageService,
  IWindowsService,
  ILifecycleService,
  IWorkspaceService,
  localize,
} from '@universe-editor/platform'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { useService } from '../useService.js'
import type { AcpSessionHistoryEntry } from '../../services/acp/acpSessionHistory.js'
import { findLabel, compareByCategory } from './ConfigOptionsBar.js'
import { activateForeignSession } from './activateForeignSession.js'
import { AgentIcon } from './agentIcon.js'
import styles from './agents.module.css'

const HISTORY_KEY = 'acp.sessionHistory'
const CONFIG_CACHE_KEY = 'acp.configOptionsCache'
const AGENT_DEFAULTS_KEY = 'acp.agentDefaults'
const SCHEMA_VERSION = 1

interface ResolvedConfig {
  id: string
  name: string
  category: SessionConfigOption['category']
  valueLabel: string
}

/** Compute the human-readable config for a foreign session from its own bucket. */
function resolveForeignConfig(
  optionsBag: readonly SessionConfigOption[],
  selected: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): ResolvedConfig[] {
  return [...optionsBag]
    .sort(compareByCategory)
    .filter((opt): opt is SessionConfigOption & { type: 'select' } => opt.type === 'select')
    .map((opt) => {
      const value = selected[opt.id] ?? defaults[opt.id] ?? opt.currentValue
      return {
        id: opt.id,
        name: opt.name,
        category: opt.category,
        valueLabel: findLabel(opt.options, value),
      }
    })
}

function categoryIcon(category: SessionConfigOption['category']) {
  switch (category) {
    case 'model':
      return Bot
    case 'mode':
      return Settings2
    case 'thought_level':
      return Sparkles
    default:
      return Sliders
  }
}

export function ForeignSessionPreview({ entry }: { entry: AcpSessionHistoryEntry }) {
  const storage = useService(IStorageService)
  const windows = useService(IWindowsService)
  const lifecycle = useService(ILifecycleService)
  const workspace = useService(IWorkspaceService)
  const [config, setConfig] = useState<ResolvedConfig[] | null>(null)

  const cwd = entry.cwd

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Feature-detect the cross-bucket read; without it we cannot show the
      // session's true config (the current bucket has none for a foreign id).
      const readBucket = storage.getForWorkspaceCwd?.bind(storage)
      if (!readBucket || cwd === undefined) {
        if (!cancelled) setConfig([])
        return
      }
      const [historyRaw, cacheRaw, defaultsRaw] = await Promise.all([
        readBucket<{ schemaVersion: number; entries: AcpSessionHistoryEntry[] }>(HISTORY_KEY, cwd),
        readBucket<{
          schemaVersion: number
          cache: Record<string, readonly SessionConfigOption[]>
        }>(CONFIG_CACHE_KEY, cwd),
        readBucket<{ schemaVersion: number; defaults: Record<string, Record<string, string>> }>(
          AGENT_DEFAULTS_KEY,
          cwd,
        ),
      ])
      if (cancelled) return
      const ownEntry =
        historyRaw?.schemaVersion === SCHEMA_VERSION
          ? historyRaw.entries.find((e) => e.id === entry.id)
          : undefined
      const selected = ownEntry?.configOptions ?? entry.configOptions ?? {}
      const bag =
        cacheRaw?.schemaVersion === SCHEMA_VERSION ? (cacheRaw.cache[entry.agentId] ?? []) : []
      const defaults =
        defaultsRaw?.schemaVersion === SCHEMA_VERSION
          ? (defaultsRaw.defaults[entry.agentId] ?? {})
          : {}
      setConfig(resolveForeignConfig(bag, selected, defaults))
    })()
    return () => {
      cancelled = true
    }
  }, [storage, cwd, entry.id, entry.agentId, entry.configOptions])

  const activate = (newWindow: boolean) => {
    if (cwd === undefined) return
    void activateForeignSession({ windows, lifecycle, workspace }, cwd, { newWindow })
  }

  return (
    <div className={styles['foreignPreview']} data-testid="acp-foreign-session-preview">
      <div className={styles['foreignPreviewHeader']}>
        <AgentIcon agentId={entry.agentId} size={18} />
        <span className={styles['foreignPreviewTitle']}>{entry.title}</span>
      </div>

      <p className={styles['foreignPreviewNote']}>
        {localize(
          'acp.foreignSession.note',
          'This session belongs to another worktree. Open it in its own context to continue working.',
        )}
      </p>

      <div className={styles['foreignPreviewMeta']}>
        {entry.branch ? (
          <span className={styles['foreignPreviewMetaRow']} title={entry.cwd}>
            <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
            {entry.branch}
          </span>
        ) : null}
        {entry.cwd ? <span className={styles['foreignPreviewPath']}>{entry.cwd}</span> : null}
      </div>

      {config && config.length > 0 ? (
        <div className={styles['foreignPreviewConfig']}>
          {config.map((c) => {
            const Icon = categoryIcon(c.category)
            return (
              <span key={c.id} className={styles['foreignPreviewConfigItem']} title={c.name}>
                <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                {c.name}: {c.valueLabel}
              </span>
            )
          })}
        </div>
      ) : null}

      <div className={styles['foreignPreviewActions']}>
        <button
          type="button"
          className={styles['sessionRetryButton']}
          onClick={() => activate(true)}
          data-testid="acp-foreign-activate-new-window"
        >
          <SquareArrowOutUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
          {localize('acp.foreignSession.openInNewWindow', 'Open Worktree in New Window')}
        </button>
        <button
          type="button"
          className={styles['sessionRetryButton']}
          onClick={() => activate(false)}
          data-testid="acp-foreign-activate-switch"
        >
          {localize('acp.foreignSession.switch', 'Switch This Window')}
        </button>
      </div>
    </div>
  )
}
