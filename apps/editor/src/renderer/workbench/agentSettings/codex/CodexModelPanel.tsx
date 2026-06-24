/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexModelPanel — the "Model & Reasoning" category. Binds the model-related
 *  keys of `~/.codex/config.toml` (model / model_provider / model_reasoning_effort)
 *  directly via ICodexConfigService. Free-text inputs commit on blur; the effort
 *  select writes through immediately.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { localize } from '@universe-editor/platform'
import { Input } from '@universe-editor/workbench-ui'
import type { CodexReasoningEffort } from '../../../../shared/ipc/codexConfigService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import styles from '../AgentSettingsEditor.module.css'

const EFFORT_LEVELS: readonly CodexReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh']

export function CodexModelPanel({ config }: { config: UseCodexConfig }) {
  const { settings, patch } = config

  // Local mirror for free-text inputs so typing stays responsive; written on blur.
  const [model, setModel] = useState(settings.model ?? '')
  const [provider, setProvider] = useState(settings.model_provider ?? '')
  useEffect(() => setModel(settings.model ?? ''), [settings.model])
  useEffect(() => setProvider(settings.model_provider ?? ''), [settings.model_provider])

  const commitText = useCallback(
    (key: 'model' | 'model_provider', value: string) => {
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
          <label className={styles['label']}>{localize('codexSettings.model', 'Model')}</label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.model.desc',
              'The model Codex uses (config.toml `model`). Leave empty to use the Codex default.',
            )}
          </div>
          <Input
            className={styles['controlNarrow']}
            value={model}
            placeholder="gpt-5.1-codex"
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => commitText('model', model)}
          />
        </div>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('codexSettings.provider', 'Model provider')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.provider.desc',
              'Provider id (config.toml `model_provider`). Defaults to "openai"; must match a built-in id or a `[model_providers.<id>]` entry.',
            )}
          </div>
          <Input
            className={styles['controlNarrow']}
            value={provider}
            placeholder="openai"
            onChange={(e) => setProvider(e.target.value)}
            onBlur={() => commitText('model_provider', provider)}
          />
        </div>
      </section>

      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('codexSettings.reasoning', 'Reasoning')}
        </h3>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('codexSettings.effort', 'Reasoning effort')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.effort.desc',
              'config.toml `model_reasoning_effort`. Higher effort spends more on thinking. Only applies on the Responses API.',
            )}
          </div>
          <select
            className={`${styles['control']} ${styles['controlNarrow']}`}
            value={settings.model_reasoning_effort ?? ''}
            onChange={(e) => {
              const v = e.target.value
              void patch({ model_reasoning_effort: v === '' ? null : (v as CodexReasoningEffort) })
            }}
          >
            <option value="">{localize('codexSettings.effort.default', '(default)')}</option>
            {EFFORT_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}
