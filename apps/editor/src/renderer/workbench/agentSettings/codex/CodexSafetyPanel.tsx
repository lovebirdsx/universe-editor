/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexSafetyPanel — the "Approval & Sandbox" category. Two selects bound to
 *  config.toml: `approval_policy` (when Codex pauses for confirmation) and
 *  `sandbox_mode` (the filesystem/network sandbox the agent runs under).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
} from '../../../../shared/ipc/codexConfigService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import styles from '../AgentSettingsEditor.module.css'

const APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = [
  'untrusted',
  'on-request',
  'on-failure',
  'never',
]

const SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
]

export function CodexSafetyPanel({ config }: { config: UseCodexConfig }) {
  const { settings, patch } = config

  return (
    <div className={styles['panel']}>
      <section className={styles['section']}>
        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('codexSettings.approval', 'Approval policy')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.approval.desc',
              'config.toml `approval_policy` — when Codex pauses to ask before running a command. Use "on-request" for interactive work, "never" for unattended runs.',
            )}
          </div>
          <select
            className={`${styles['control']} ${styles['controlNarrow']}`}
            value={settings.approval_policy ?? ''}
            onChange={(e) => {
              const v = e.target.value
              void patch({ approval_policy: v === '' ? null : (v as CodexApprovalPolicy) })
            }}
          >
            <option value="">{localize('codexSettings.approval.default', '(default)')}</option>
            {APPROVAL_POLICIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className={styles['field']}>
          <label className={styles['label']}>
            {localize('codexSettings.sandbox', 'Sandbox mode')}
          </label>
          <div className={styles['desc']}>
            {localize(
              'codexSettings.sandbox.desc',
              'config.toml `sandbox_mode` — the filesystem/network sandbox Codex runs under. "danger-full-access" disables the sandbox entirely.',
            )}
          </div>
          <select
            className={`${styles['control']} ${styles['controlNarrow']}`}
            value={settings.sandbox_mode ?? ''}
            onChange={(e) => {
              const v = e.target.value
              void patch({ sandbox_mode: v === '' ? null : (v as CodexSandboxMode) })
            }}
          >
            <option value="">{localize('codexSettings.sandbox.default', '(default)')}</option>
            {SANDBOX_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </section>
    </div>
  )
}
