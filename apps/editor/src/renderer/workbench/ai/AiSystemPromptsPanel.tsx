/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiSystemPromptsPanel — the "System Prompts" category of the AI settings editor.
 *  Each AI feature (commit message / inline completion / session title) gets a
 *  multi-line textarea overriding its system prompt. Empty means "use the built-in
 *  default", shown as the textarea placeholder; "Restore default" clears the
 *  override. Overrides persist to aiSettings.json via IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  GitCommitHorizontal,
  Heading,
  RotateCcw,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react'
import { IAiModelService, localize, type AiPromptKind } from '@universe-editor/platform'
import { IconButton } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  DEFAULT_COMMIT_SYSTEM_PROMPT,
  DEFAULT_INLINE_COMPLETION_SYSTEM_PROMPT,
  DEFAULT_SESSION_TITLE_SYSTEM_PROMPT,
} from '../../services/ai/defaultSystemPrompts.js'
import styles from './AiSettingsEditor.module.css'

interface PromptDef {
  readonly kind: AiPromptKind
  readonly icon: LucideIcon
  readonly label: string
  readonly description: string
  readonly placeholder: string
}

const PROMPTS: readonly PromptDef[] = [
  {
    kind: 'commit',
    icon: GitCommitHorizontal,
    label: localize('aiPrompts.commit', 'Commit Message'),
    description: localize(
      'aiPrompts.commit.desc',
      'System prompt for generating Git commit messages.',
    ),
    placeholder: DEFAULT_COMMIT_SYSTEM_PROMPT,
  },
  {
    kind: 'inlineCompletion',
    icon: WandSparkles,
    label: localize('aiPrompts.inline', 'Inline Completion'),
    description: localize(
      'aiPrompts.inline.desc',
      'System prompt for editor ghost-text suggestions.',
    ),
    placeholder: DEFAULT_INLINE_COMPLETION_SYSTEM_PROMPT,
  },
  {
    kind: 'sessionTitle',
    icon: Heading,
    label: localize('aiPrompts.sessionTitle', 'Session Title'),
    description: localize(
      'aiPrompts.sessionTitle.desc',
      'System prompt for naming AGENTS sessions.',
    ),
    placeholder: DEFAULT_SESSION_TITLE_SYSTEM_PROMPT,
  },
]

const SAVE_DEBOUNCE_MS = 400

export function AiSystemPromptsPanel() {
  const aiModel = useService(IAiModelService)
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  // Suppress the change-event-driven reload triggered by our own writes.
  const selfWriteRef = useRef(false)

  const reload = useCallback(async () => {
    const prompts = await Promise.all(PROMPTS.map((p) => aiModel.getSystemPrompt(p.kind)))
    const next: Record<string, string> = {}
    PROMPTS.forEach((p, i) => {
      next[p.kind] = prompts[i] ?? ''
    })
    setValues(next)
  }, [aiModel])

  useEffect(() => {
    void reload()
    const d = aiModel.onDidChangeSystemPrompts(() => {
      if (selfWriteRef.current) {
        selfWriteRef.current = false
        return
      }
      void reload()
    })
    return () => d.dispose()
  }, [aiModel, reload])

  // Debounced persistence per edit. The map of timers is keyed by prompt kind.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const scheduleSave = useCallback(
    (kind: AiPromptKind, value: string) => {
      const timers = timersRef.current
      const existing = timers.get(kind)
      if (existing) clearTimeout(existing)
      timers.set(
        kind,
        setTimeout(() => {
          timers.delete(kind)
          selfWriteRef.current = true
          void aiModel.setSystemPrompt(kind, value.trim() === '' ? undefined : value)
        }, SAVE_DEBOUNCE_MS),
      )
    },
    [aiModel],
  )

  const onChange = useCallback(
    (kind: AiPromptKind, value: string) => {
      setValues((prev) => ({ ...prev, [kind]: value }))
      scheduleSave(kind, value)
    },
    [scheduleSave],
  )

  const restoreDefault = useCallback(
    (kind: AiPromptKind) => {
      const timers = timersRef.current
      const existing = timers.get(kind)
      if (existing) {
        clearTimeout(existing)
        timers.delete(kind)
      }
      setValues((prev) => ({ ...prev, [kind]: '' }))
      selfWriteRef.current = true
      void aiModel.setSystemPrompt(kind, undefined)
    },
    [aiModel],
  )

  return (
    <div className={styles['panel']}>
      <ul className={styles['promptList']}>
        {PROMPTS.map((prompt) => {
          const Icon = prompt.icon
          const value = values[prompt.kind] ?? ''
          return (
            <li key={prompt.kind} className={styles['promptField']}>
              <div className={styles['promptHeader']}>
                <Icon size={18} strokeWidth={1.75} className={styles['promptIcon']} />
                <div className={styles['promptMeta']}>
                  <span className={styles['promptName']}>{prompt.label}</span>
                  <span className={styles['promptDesc']}>{prompt.description}</span>
                </div>
                <IconButton
                  label={localize('aiPrompts.resetDefault', 'Restore default')}
                  disabled={value === ''}
                  onClick={() => restoreDefault(prompt.kind)}
                >
                  <RotateCcw size={15} strokeWidth={1.75} />
                </IconButton>
              </div>
              <textarea
                className={styles['promptTextarea']}
                value={value}
                placeholder={prompt.placeholder}
                spellCheck={false}
                onChange={(e) => onChange(prompt.kind, e.target.value)}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
