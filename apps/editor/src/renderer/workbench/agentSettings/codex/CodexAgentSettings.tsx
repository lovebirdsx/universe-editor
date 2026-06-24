/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexAgentSettings — the settings component contributed for the `codex` agent.
 *  Owns a single useCodexConfig() instance (bound to ~/.codex/config.toml +
 *  auth.json, shared with the built-in codex-acp agent and the local Codex CLI)
 *  and a category sub-nav across authentication, model/reasoning, safety and
 *  advanced panels.
 *
 *  Registered into the agentSettingsRegistry at module load, so the Settings shell
 *  renders it when the Codex agent is selected.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { KeyRound, ShieldCheck, SlidersHorizontal, Terminal, type LucideIcon } from 'lucide-react'
import { IStorageService, StorageScope, localize } from '@universe-editor/platform'
import { cx } from '@universe-editor/workbench-ui'
import { useService } from '../../useService.js'
import { registerAgentSettings } from '../agentSettingsRegistry.js'
import { CodexAuthenticationPanel } from './CodexAuthenticationPanel.js'
import { CodexModelPanel } from './CodexModelPanel.js'
import { CodexSafetyPanel } from './CodexSafetyPanel.js'
import { CodexAdvancedPanel } from './CodexAdvancedPanel.js'
import { useCodexConfig, type UseCodexConfig } from './useCodexConfig.js'
import styles from '../AgentSettingsEditor.module.css'

interface CategoryDef {
  readonly id: string
  readonly icon: LucideIcon
  readonly label: string
  readonly panel: ComponentType<{ config: UseCodexConfig }>
}

const CATEGORIES: readonly CategoryDef[] = [
  {
    id: 'auth',
    icon: KeyRound,
    label: localize('codexSettings.category.auth', 'Authentication'),
    panel: CodexAuthenticationPanel,
  },
  {
    id: 'model',
    icon: SlidersHorizontal,
    label: localize('codexSettings.category.model', 'Model & Reasoning'),
    panel: CodexModelPanel,
  },
  {
    id: 'safety',
    icon: ShieldCheck,
    label: localize('codexSettings.category.safety', 'Approval & Sandbox'),
    panel: CodexSafetyPanel,
  },
  {
    id: 'advanced',
    icon: Terminal,
    label: localize('codexSettings.category.advanced', 'Advanced'),
    panel: CodexAdvancedPanel,
  },
]

const ACTIVE_CATEGORY_KEY = 'agent.settings.codex.activeCategory'
const scrollKey = (categoryId: string): string => `agent.settings.codex.scroll.${categoryId}`

export function CodexAgentSettings() {
  const storage = useService(IStorageService)
  const config = useCodexConfig()
  const [categoryId, setCategoryId] = useState<string>(CATEGORIES[0]!.id)
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)

  useEffect(() => {
    let active = true
    void storage.get<string>(ACTIVE_CATEGORY_KEY, StorageScope.GLOBAL).then((stored) => {
      if (active && stored && CATEGORIES.some((c) => c.id === stored)) setCategoryId(stored)
      if (active) restoredRef.current = true
    })
    return () => {
      active = false
    }
  }, [storage])

  useEffect(() => {
    let active = true
    void storage.get<number>(scrollKey(categoryId), StorageScope.GLOBAL).then((top) => {
      if (!active) return
      requestAnimationFrame(() => {
        if (active && bodyRef.current && typeof top === 'number') bodyRef.current.scrollTop = top
      })
    })
    return () => {
      active = false
    }
  }, [storage, categoryId])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void storage.set(scrollKey(categoryId), el.scrollTop, StorageScope.GLOBAL)
      }, 200)
    }
    el.addEventListener('scroll', onScroll)
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (timer) clearTimeout(timer)
    }
  }, [storage, categoryId])

  const switchCategory = useCallback(
    (next: string) => {
      if (next === categoryId) return
      if (bodyRef.current) {
        void storage.set(scrollKey(categoryId), bodyRef.current.scrollTop, StorageScope.GLOBAL)
      }
      setCategoryId(next)
      if (restoredRef.current) void storage.set(ACTIVE_CATEGORY_KEY, next, StorageScope.GLOBAL)
    },
    [categoryId, storage],
  )

  const category = CATEGORIES.find((c) => c.id === categoryId) ?? CATEGORIES[0]!
  const Panel = category.panel

  return (
    <div className={styles['agentBody']}>
      <nav
        className={styles['subNav']}
        aria-label={localize('codexSettings.nav', 'Codex settings categories')}
      >
        {CATEGORIES.map((c) => {
          const Icon = c.icon
          return (
            <button
              key={c.id}
              type="button"
              className={cx(styles['navItem'], c.id === categoryId && styles['navItemActive'])}
              aria-current={c.id === categoryId}
              onClick={() => switchCategory(c.id)}
            >
              <Icon size={16} strokeWidth={1.75} className={styles['navIcon']} />
              <span>{c.label}</span>
            </button>
          )
        })}
      </nav>

      <div className={styles['subBody']} ref={bodyRef}>
        {config.loaded && <Panel config={config} />}
      </div>
    </div>
  )
}

registerAgentSettings('codex', CodexAgentSettings)
