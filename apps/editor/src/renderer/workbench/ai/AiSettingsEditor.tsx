/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiSettingsEditor — the unified settings shell for AI and Agents. A fixed
 *  left-hand nav (mirroring the Settings editor) is split into two groups:
 *    • AI      — static categories (model configuration, feature models)
 *    • Agents  — every known ACP agent (from IAcpAgentRegistry); selecting one
 *                renders the settings UI that agent contributed (Claude carries
 *                its own auth / model / env sub-nav).
 *  The active item is persisted (GLOBAL scope) so the page reopens where the
 *  user left it. AI categories also persist their scroll position; agent panels
 *  manage their own scrolling internally.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { Boxes, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { IStorageService, StorageScope, localize } from '@universe-editor/platform'
import { cx } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { IAcpAgentRegistry } from '../../services/acp/acpAgentRegistry.js'
import { AgentIcon } from '../agents/agentIcon.js'
import { getAgentSettingsComponent } from '../agentSettings/agentSettingsRegistry.js'
import { AiModelsPanel } from './AiModelsPanel.js'
import { AiFeatureModelsPanel } from './AiFeatureModelsPanel.js'
import { AiSettingsHelpButton } from './AiSettingsHelpButton.js'
import { aiFeatureModelsHelpText, aiModelsHelpText } from './aiSettingsHelpText.js'
import styles from './AiSettingsEditor.module.css'
import '../agentSettings/builtinAgentSettings.js'

interface AiCategoryDef {
  readonly id: string
  readonly icon: LucideIcon
  readonly label: string
  readonly panel: ComponentType
  readonly help: () => string
}

const AI_CATEGORIES: readonly AiCategoryDef[] = [
  {
    id: 'aiModels',
    icon: Boxes,
    label: localize('aiSettings.category.models', 'Model Configuration'),
    panel: AiModelsPanel,
    help: aiModelsHelpText,
  },
  {
    id: 'featureModels',
    icon: SlidersHorizontal,
    label: localize('aiSettings.category.features', 'Feature Models'),
    panel: AiFeatureModelsPanel,
    help: aiFeatureModelsHelpText,
  },
]

const aiItemKey = (categoryId: string): string => `ai:${categoryId}`
const agentItemKey = (agentId: string): string => `agent:${agentId}`

const ACTIVE_ITEM_KEY = 'settings.activeItem'
const scrollKey = (itemId: string): string => `ai.settings.scroll.${itemId}`

export function AiSettingsEditor() {
  const storage = useService(IStorageService)
  const registry = useService(IAcpAgentRegistry)
  const agents = registry.list()

  const [itemId, setItemId] = useState<string>(aiItemKey(AI_CATEGORIES[0]!.id))
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)

  const isValidItem = useCallback(
    (id: string): boolean => {
      if (id.startsWith('ai:')) return AI_CATEGORIES.some((c) => aiItemKey(c.id) === id)
      if (id.startsWith('agent:')) return agents.some((a) => agentItemKey(a.id) === id)
      return false
    },
    [agents],
  )

  // Restore the last active item before the first persisting effect runs.
  useEffect(() => {
    let active = true
    void storage.get<string>(ACTIVE_ITEM_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored && isValidItem(stored)) setItemId(stored)
      if (active) restoredRef.current = true
    })
    return () => {
      active = false
    }
  }, [storage, isValidItem])

  const isAiItem = itemId.startsWith('ai:')

  // Restore the scroll position for AI categories whenever the active item
  // changes (after the panel has had a chance to render). Agent panels scroll
  // internally and aren't tracked here.
  useEffect(() => {
    if (!isAiItem) return
    let active = true
    void storage.get<number>(scrollKey(itemId), StorageScope.GLOBAL).then((top) => {
      if (!active) return
      requestAnimationFrame(() => {
        if (active && bodyRef.current && typeof top === 'number') bodyRef.current.scrollTop = top
      })
    })
    return () => {
      active = false
    }
  }, [storage, itemId, isAiItem])

  // Persist scroll position as the user scrolls (debounced). AI categories only.
  useEffect(() => {
    if (!isAiItem) return
    const el = bodyRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void storage.set(scrollKey(itemId), el.scrollTop, StorageScope.GLOBAL)
      }, 200)
    }
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [storage, itemId, isAiItem])

  const switchItem = useCallback(
    (next: string) => {
      if (next === itemId) return
      // Flush the current scroll position to the OLD item before switching.
      if (itemId.startsWith('ai:') && bodyRef.current) {
        void storage.set(scrollKey(itemId), bodyRef.current.scrollTop, StorageScope.GLOBAL)
      }
      setItemId(next)
      if (restoredRef.current) void storage.set(ACTIVE_ITEM_KEY, next, StorageScope.GLOBAL)
    },
    [itemId, storage],
  )

  const aiCategory = isAiItem
    ? (AI_CATEGORIES.find((c) => aiItemKey(c.id) === itemId) ?? AI_CATEGORIES[0]!)
    : undefined
  const selectedAgent = !isAiItem
    ? (agents.find((a) => agentItemKey(a.id) === itemId) ?? agents[0])
    : undefined
  const AgentSettings = selectedAgent ? getAgentSettingsComponent(selectedAgent.id) : undefined

  const AiPanel = aiCategory?.panel

  return (
    <div className={styles['root']}>
      <nav
        className={styles['nav']}
        aria-label={localize('aiSettings.nav', 'AI Settings categories')}
      >
        <div className={styles['navTitle']}>{localize('aiSettings.title', 'AI Settings')}</div>

        <div className={styles['navGroupTitle']}>{localize('aiSettings.group.ai', 'AI')}</div>
        {AI_CATEGORIES.map((c) => {
          const Icon = c.icon
          const id = aiItemKey(c.id)
          return (
            <button
              key={id}
              type="button"
              className={cx(styles['navItem'], id === itemId && styles['navItemActive'])}
              aria-current={id === itemId}
              onClick={() => switchItem(id)}
            >
              <Icon size={16} strokeWidth={1.75} className={styles['navIcon']} />
              <span>{c.label}</span>
            </button>
          )
        })}

        <div className={styles['navGroupTitle']}>
          {localize('aiSettings.group.agents', 'Agents')}
        </div>
        {agents.map((a) => {
          const id = agentItemKey(a.id)
          return (
            <button
              key={id}
              type="button"
              className={cx(styles['navItem'], id === itemId && styles['navItemActive'])}
              aria-current={id === itemId}
              onClick={() => switchItem(id)}
            >
              <AgentIcon agentId={a.id} size={16} className={styles['navIcon']} />
              <span>{a.name}</span>
            </button>
          )
        })}
      </nav>

      <div className={styles['content']}>
        {aiCategory && AiPanel ? (
          <>
            <div className={styles['contentHeader']}>
              <h1 className={styles['contentTitle']}>{aiCategory.label}</h1>
              <AiSettingsHelpButton markdown={aiCategory.help()} />
            </div>
            <div className={styles['body']} ref={bodyRef}>
              <AiPanel />
            </div>
          </>
        ) : (
          <>
            <div className={styles['contentHeader']}>
              <h1 className={styles['contentTitle']}>{selectedAgent?.name ?? ''}</h1>
            </div>
            {AgentSettings && selectedAgent ? (
              <AgentSettings agentId={selectedAgent.id} />
            ) : (
              <div className={styles['body']}>
                <div className={styles['emptyDesc']}>
                  {localize(
                    'agentSettings.noSettings',
                    'This agent has no configurable settings in the editor yet.',
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
