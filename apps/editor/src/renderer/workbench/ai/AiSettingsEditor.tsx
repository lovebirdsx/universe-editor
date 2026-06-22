/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiSettingsEditor — shell for the graphical AI settings manager. A fixed
 *  left-hand category nav (mirroring the Settings editor) switches between the
 *  model-configuration panel and the feature-models panel. The active category
 *  and each category's scroll position are persisted (GLOBAL scope) so the page
 *  reopens exactly where the user left it, even across restarts. Each category
 *  header carries a "?" button that opens markdown help.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react'
import { Boxes, SlidersHorizontal, type LucideIcon } from 'lucide-react'
import { IStorageService, StorageScope, localize } from '@universe-editor/platform'
import { cx } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { AiModelsPanel } from './AiModelsPanel.js'
import { AiFeatureModelsPanel } from './AiFeatureModelsPanel.js'
import { AiSettingsHelpButton } from './AiSettingsHelpButton.js'
import { aiFeatureModelsHelpText, aiModelsHelpText } from './aiSettingsHelpText.js'
import styles from './AiSettingsEditor.module.css'

interface CategoryDef {
  readonly id: string
  readonly icon: LucideIcon
  readonly label: string
  readonly panel: ComponentType
  readonly help: () => string
}

const CATEGORIES: readonly CategoryDef[] = [
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

const ACTIVE_CATEGORY_KEY = 'ai.settings.activeCategory'
const scrollKey = (categoryId: string): string => `ai.settings.scroll.${categoryId}`

export function AiSettingsEditor() {
  const storage = useService(IStorageService)
  const [categoryId, setCategoryId] = useState<string>(CATEGORIES[0]!.id)
  const bodyRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)

  // Restore the last active category before the first persisting effect runs.
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

  // Restore the scroll position whenever the active category changes (after the
  // panel has had a chance to render).
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

  // Persist scroll position as the user scrolls (debounced).
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
      // Flush the current scroll position to the OLD category before switching.
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
    <div className={styles['root']}>
      <nav
        className={styles['nav']}
        aria-label={localize('aiSettings.nav', 'AI settings categories')}
      >
        <div className={styles['navTitle']}>{localize('aiSettings.title', 'AI Settings')}</div>
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

      <div className={styles['content']}>
        <div className={styles['contentHeader']}>
          <h1 className={styles['contentTitle']}>{category.label}</h1>
          <AiSettingsHelpButton markdown={category.help()} />
        </div>
        <div className={styles['body']} ref={bodyRef}>
          <Panel />
        </div>
      </div>
    </div>
  )
}
