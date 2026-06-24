/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexSafetyPanel — the "Approval & Sandbox" category. Two selects bound to
 *  config.toml: `approval_policy` (when Codex pauses for confirmation) and
 *  `sandbox_mode` (the filesystem/network sandbox the agent runs under).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import { Select } from '@universe-editor/workbench-ui'
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
          <Select
            className={styles['controlNarrow']}
            aria-label={localize('codexSettings.approval', 'Approval policy')}
            value={settings.approval_policy ?? ''}
            options={[
              { value: '', label: localize('codexSettings.approval.default', '(default)') },
              ...APPROVAL_POLICIES.map((p) => ({ value: p, label: p })),
            ]}
            onChange={(v) =>
              void patch({ approval_policy: v === '' ? null : (v as CodexApprovalPolicy) })
            }
          />
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
          <Select
            className={styles['controlNarrow']}
            aria-label={localize('codexSettings.sandbox', 'Sandbox mode')}
            value={settings.sandbox_mode ?? ''}
            options={[
              { value: '', label: localize('codexSettings.sandbox.default', '(default)') },
              ...SANDBOX_MODES.map((m) => ({ value: m, label: m })),
            ]}
            onChange={(v) =>
              void patch({ sandbox_mode: v === '' ? null : (v as CodexSandboxMode) })
            }
          />
        </div>
      </section>
    </div>
  )
}
