/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AdvancedEnvPanel — the "Advanced (env)" category. Surfaces a couple of known
 *  runtime toggles plus a free key-value editor over the `env` block of
 *  `~/.claude/settings.json`. The agent applies this env block at startup
 *  (vendor index.ts), so these reach the SDK process.
 *
 *  Auth-related env keys (ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL) are owned by
 *  the Authentication panel and hidden here to avoid two sources of truth.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { Input, IconButton, Toggle } from '@universe-editor/workbench-ui'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import styles from '../AgentSettingsEditor.module.css'

/** Env keys the Authentication panel owns — never shown in the free editor. */
const AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])

const AUTO_COMPACT_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const PROMPT_CACHING_KEY = 'ENABLE_PROMPT_CACHING_1H'

export function AdvancedEnvPanel({ config }: { config: UseClaudeConfig }) {
  const { settings, patch } = config
  const env = useMemo(() => settings.env ?? {}, [settings.env])

  const setEnv = useCallback(
    (key: string, value: string | null) => void patch({ env: { [key]: value } }),
    [patch],
  )

  const [autoCompact, setAutoCompact] = useState(env[AUTO_COMPACT_KEY] ?? '')
  useEffect(() => setAutoCompact(env[AUTO_COMPACT_KEY] ?? ''), [env])

  const customEntries = Object.entries(env).filter(
    ([k]) => !AUTH_ENV_KEYS.has(k) && k !== AUTO_COMPACT_KEY && k !== PROMPT_CACHING_KEY,
  )

  return (
    <div className={styles['panel']}>
      <section className={styles['section']}>
        <div className={styles['fieldRow']}>
          <div className={styles['radioBody']}>
            <span className={styles['label']}>
              {localize('agentSettings.promptCaching', 'Enable 1h prompt caching')}
            </span>
            <span className={styles['desc']}>{`env.${PROMPT_CACHING_KEY}`}</span>
          </div>
          <Toggle
            checked={env[PROMPT_CACHING_KEY] === '1' || env[PROMPT_CACHING_KEY] === 'true'}
            onChange={(checked) => setEnv(PROMPT_CACHING_KEY, checked ? '1' : null)}
            aria-label={localize('agentSettings.promptCaching', 'Enable 1h prompt caching')}
          />
        </div>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('agentSettings.autoCompact', 'Auto-compact window')}
          </label>
          <div className={styles['desc']}>{`env.${AUTO_COMPACT_KEY}`}</div>
          <Input
            className={styles['controlNarrow']}
            value={autoCompact}
            placeholder="e.g. 200000"
            onChange={(e) => setAutoCompact(e.target.value)}
            onBlur={() => {
              const trimmed = autoCompact.trim()
              if (trimmed === (env[AUTO_COMPACT_KEY] ?? '')) return
              setEnv(AUTO_COMPACT_KEY, trimmed === '' ? null : trimmed)
            }}
          />
        </div>
      </section>

      <CustomEnvEditor entries={customEntries} onSet={setEnv} />
    </div>
  )
}

function CustomEnvEditor({
  entries,
  onSet,
}: {
  entries: readonly [string, string][]
  onSet: (key: string, value: string | null) => void
}) {
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const addEntry = useCallback(() => {
    const k = newKey.trim()
    if (!k) return
    onSet(k, newValue)
    setNewKey('')
    setNewValue('')
  }, [newKey, newValue, onSet])

  return (
    <section className={styles['section']}>
      <h3 className={styles['sectionTitle']}>
        {localize('agentSettings.customEnv', 'Custom environment variables')}
      </h3>
      <div className={styles['desc']}>
        {localize(
          'agentSettings.customEnv.desc',
          'Extra entries written to the env block of settings.json, applied to the agent at startup.',
        )}
      </div>

      {entries.map(([key, value]) => (
        <div key={key} className={styles['envRow']}>
          <Input className={styles['envKey']} value={key} disabled />
          <Input
            className={styles['envValue']}
            defaultValue={value}
            onBlur={(e) => {
              if (e.target.value !== value) onSet(key, e.target.value)
            }}
          />
          <IconButton
            label={localize('agentSettings.customEnv.remove', 'Remove {key}', { key })}
            onClick={() => onSet(key, null)}
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      ))}

      <div className={styles['envRow']}>
        <Input
          className={styles['envKey']}
          value={newKey}
          placeholder={localize('agentSettings.customEnv.key', 'KEY')}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <Input
          className={styles['envValue']}
          value={newValue}
          placeholder={localize('agentSettings.customEnv.value', 'value')}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addEntry()
            }
          }}
        />
        <IconButton
          label={localize('agentSettings.customEnv.add', 'Add variable')}
          onClick={addEntry}
        >
          <Plus size={15} strokeWidth={2} />
        </IconButton>
      </div>
    </section>
  )
}
