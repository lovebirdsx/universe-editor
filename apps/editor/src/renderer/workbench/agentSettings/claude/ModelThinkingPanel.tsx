/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ModelThinkingPanel — the "Model & Thinking" category. Binds the top-level
 *  Claude Code settings (model / language / thinking / effort / summaries /
 *  availableModels allowlist) directly to `~/.claude/settings.json` via
 *  IClaudeConfigService. Every control writes through on change.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { Input, Select, Toggle } from '@universe-editor/workbench-ui'
import type { ClaudeEffortLevel } from '../../../../shared/ipc/claudeConfigService.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import styles from '../AgentSettingsEditor.module.css'

const EFFORT_LEVELS: readonly ClaudeEffortLevel[] = ['low', 'medium', 'high', 'xhigh']

export function ModelThinkingPanel({ config }: { config: UseClaudeConfig }) {
  const { settings, patch } = config

  // Local mirror for free-text inputs so typing stays responsive; written on blur.
  const [model, setModel] = useState(settings.model ?? '')
  const [language, setLanguage] = useState(settings.language ?? '')
  useEffect(() => setModel(settings.model ?? ''), [settings.model])
  useEffect(() => setLanguage(settings.language ?? ''), [settings.language])

  const commitText = useCallback(
    (key: 'model' | 'language', value: string) => {
      const trimmed = value.trim()
      const current = (settings[key] as string | undefined) ?? ''
      if (trimmed === current) return
      void patch({ [key]: trimmed === '' ? null : trimmed })
    },
    [patch, settings],
  )

  return (
    <div className={styles['panel']}>
      <section className={styles['section']}>
        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('agentSettings.model', 'Default model')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'agentSettings.model.desc',
              'Overrides the model used by the agent (Settings.model). Leave empty to use the default.',
            )}
          </div>
          <Input
            className={styles['controlNarrow']}
            value={model}
            placeholder="claude-opus-4-8"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => commitText('model', model)}
          />
        </div>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('agentSettings.language', 'Language')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'agentSettings.language.desc',
              'Preferred language for the agent’s responses (e.g. "japanese", "chinese").',
            )}
          </div>
          <Input
            className={styles['controlNarrow']}
            value={language}
            placeholder="chinese"
            onChange={(e) => setLanguage(e.target.value)}
            onBlur={() => commitText('language', language)}
          />
        </div>
      </section>

      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>{localize('agentSettings.thinking', 'Thinking')}</h3>

        <div className={styles['fieldRow']}>
          <div className={styles['radioBody']}>
            <span className={styles['label']}>
              {localize('agentSettings.alwaysThinking', 'Always enable thinking')}
            </span>
            <span className={styles['desc']}>
              {localize(
                'agentSettings.alwaysThinking.desc',
                'When off, thinking is disabled (Settings.alwaysThinkingEnabled).',
              )}
            </span>
          </div>
          <Toggle
            checked={settings.alwaysThinkingEnabled !== false}
            onChange={(checked) => void patch({ alwaysThinkingEnabled: checked })}
            aria-label={localize('agentSettings.alwaysThinking', 'Always enable thinking')}
          />
        </div>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('agentSettings.effortLevel', 'Effort level')}
          </label>
          <Select
            className={styles['controlNarrow']}
            aria-label={localize('agentSettings.effortLevel', 'Effort level')}
            value={settings.effortLevel ?? ''}
            options={[
              { value: '', label: localize('agentSettings.effortLevel.default', '(default)') },
              ...EFFORT_LEVELS.map((lvl) => ({ value: lvl, label: lvl })),
            ]}
            onChange={(v) =>
              void patch({ effortLevel: v === '' ? null : (v as ClaudeEffortLevel) })
            }
          />
        </div>

        <div className={styles['fieldRow']}>
          <div className={styles['radioBody']}>
            <span className={styles['label']}>
              {localize('agentSettings.showThinkingSummaries', 'Show thinking summaries')}
            </span>
            <span className={styles['desc']}>
              {localize(
                'agentSettings.showThinkingSummaries.desc',
                'Display summarized thinking (Settings.showThinkingSummaries).',
              )}
            </span>
          </div>
          <Toggle
            checked={settings.showThinkingSummaries === true}
            onChange={(checked) => void patch({ showThinkingSummaries: checked })}
            aria-label={localize('agentSettings.showThinkingSummaries', 'Show thinking summaries')}
          />
        </div>
      </section>

      <AvailableModels config={config} />
    </div>
  )
}

/** `availableModels` allowlist editor — a simple add/remove tag list. */
function AvailableModels({ config }: { config: UseClaudeConfig }) {
  const { settings, patch } = config
  const models = useMemo(
    () => (Array.isArray(settings.availableModels) ? settings.availableModels : []),
    [settings.availableModels],
  )
  const [draft, setDraft] = useState('')

  const add = useCallback(() => {
    const v = draft.trim()
    if (!v || models.includes(v)) {
      setDraft('')
      return
    }
    void patch({ availableModels: [...models, v] })
    setDraft('')
  }, [draft, models, patch])

  const remove = useCallback(
    (model: string) => {
      const next = models.filter((m) => m !== model)
      void patch({ availableModels: next.length > 0 ? next : null })
    },
    [models, patch],
  )

  return (
    <section className={styles['section']}>
      <h3 className={styles['sectionTitle']}>
        {localize('agentSettings.availableModels', 'Allowed models')}
      </h3>
      <div className={styles['desc']}>
        {localize(
          'agentSettings.availableModels.desc',
          'Restrict the model picker to these ids (Settings.availableModels). Empty = all models.',
        )}
      </div>
      {models.length > 0 && (
        <div className={styles['tagList']}>
          {models.map((m) => (
            <span key={m} className={styles['tag']}>
              {m}
              <button
                type="button"
                className={styles['tagRemove']}
                aria-label={localize('agentSettings.availableModels.remove', 'Remove {model}', {
                  model: m,
                })}
                onClick={() => remove(m)}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        className={styles['controlNarrow']}
        value={draft}
        placeholder={localize('agentSettings.availableModels.add', 'Add model id + Enter')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
      />
    </section>
  )
}
