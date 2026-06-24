/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexAdvancedPanel — the "Advanced" category. A credential-store select, a
 *  reasoning-visibility toggle, plus a free scalar key editor over config.toml.
 *
 *  Keys owned by the other panels (model / approval / sandbox / base URL) are
 *  hidden here, and only scalar values (string/number/boolean) are editable —
 *  nested tables like `[model_providers.*]` are left to the raw config file.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { Input, IconButton, Select, Toggle } from '@universe-editor/workbench-ui'
import type { CodexCredentialStore } from '../../../../shared/ipc/codexConfigService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import styles from '../AgentSettingsEditor.module.css'

/** config.toml keys owned by other panels — never shown in the free editor. */
const MANAGED_KEYS = new Set([
  'model',
  'model_provider',
  'model_reasoning_effort',
  'approval_policy',
  'sandbox_mode',
  'openai_base_url',
  'cli_auth_credentials_store',
  'hide_agent_reasoning',
])

const CREDENTIAL_STORES: readonly CodexCredentialStore[] = ['auto', 'file', 'keyring']

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

export function CodexAdvancedPanel({ config }: { config: UseCodexConfig }) {
  const { settings, patch } = config

  const customEntries = Object.entries(settings).filter(
    ([k, v]) => !MANAGED_KEYS.has(k) && isScalar(v),
  ) as [string, string | number | boolean][]

  return (
    <div className={styles['panel']}>
      <section className={styles['section']}>
        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('codexSettings.credentialStore', 'Credential storage')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.credentialStore.desc',
              'config.toml `cli_auth_credentials_store` — where Codex keeps credentials: "file" (auth.json), "keyring" (OS store), or "auto".',
            )}
          </div>
          <Select
            className={styles['controlNarrow']}
            aria-label={localize('codexSettings.credentialStore', 'Credential storage')}
            value={settings.cli_auth_credentials_store ?? ''}
            options={[
              { value: '', label: localize('codexSettings.credentialStore.default', '(default)') },
              ...CREDENTIAL_STORES.map((s) => ({ value: s, label: s })),
            ]}
            onChange={(v) =>
              void patch({
                cli_auth_credentials_store: v === '' ? null : (v as CodexCredentialStore),
              })
            }
          />
        </div>

        <div className={styles['fieldRow']}>
          <div className={styles['radioBody']}>
            <span className={styles['label']}>
              {localize('codexSettings.hideReasoning', 'Hide agent reasoning')}
            </span>
            <span className={styles['desc']}>{'config.toml hide_agent_reasoning'}</span>
          </div>
          <Toggle
            checked={settings.hide_agent_reasoning === true}
            onChange={(checked) => void patch({ hide_agent_reasoning: checked ? true : null })}
            aria-label={localize('codexSettings.hideReasoning', 'Hide agent reasoning')}
          />
        </div>
      </section>

      <CustomKeyEditor entries={customEntries} patch={patch} />
    </div>
  )
}

function CustomKeyEditor({
  entries,
  patch,
}: {
  entries: readonly [string, string | number | boolean][]
  patch: UseCodexConfig['patch']
}) {
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const addEntry = useCallback(() => {
    const k = newKey.trim()
    if (!k) return
    void patch({ [k]: newValue })
    setNewKey('')
    setNewValue('')
  }, [newKey, newValue, patch])

  return (
    <section className={styles['section']}>
      <h3 className={styles['sectionTitle']}>
        {localize('codexSettings.customKeys', 'Other config keys')}
      </h3>
      <div className={styles['desc']}>
        {localize(
          'codexSettings.customKeys.desc',
          'Extra top-level keys written to config.toml. Values are stored as text; nested tables are not shown here.',
        )}
      </div>

      {entries.map(([key, value]) => (
        <div key={key} className={styles['envRow']}>
          <Input className={styles['envKey']} value={key} disabled />
          <Input
            className={styles['envValue']}
            defaultValue={String(value)}
            onBlur={(e) => {
              if (e.target.value !== String(value)) void patch({ [key]: e.target.value })
            }}
          />
          <IconButton
            label={localize('codexSettings.customKeys.remove', 'Remove {key}', { key })}
            onClick={() => void patch({ [key]: null })}
          >
            <Trash2 size={15} strokeWidth={1.75} />
          </IconButton>
        </div>
      ))}

      <div className={styles['envRow']}>
        <Input
          className={styles['envKey']}
          value={newKey}
          placeholder={localize('codexSettings.customKeys.key', 'key')}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <Input
          className={styles['envValue']}
          value={newValue}
          placeholder={localize('codexSettings.customKeys.value', 'value')}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addEntry()
            }
          }}
        />
        <IconButton label={localize('codexSettings.customKeys.add', 'Add key')} onClick={addEntry}>
          <Plus size={15} strokeWidth={2} />
        </IconButton>
      </div>
    </section>
  )
}
