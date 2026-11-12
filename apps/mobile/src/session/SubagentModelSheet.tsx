import type { MobileSubagentModelSettings } from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import { ConfirmActionSheet } from '../components/ConfirmActionSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { errorCode } from '../errors.js'
import { commandErrorText, strings } from '../strings.js'

export interface SubagentModelSheetProps {
  readonly client: Pick<MobileClient, 'setSubagentModel' | 'restartAgentProcess'>
  readonly settings: MobileSubagentModelSettings
  readonly running: boolean
  readonly online: boolean
  readonly onChanged: (current: string | null) => void
  readonly onClose: () => void
  readonly onNotice: (text: string) => void
}

/**
 * Subagent model pick. The value travels as spawn env, so the sheet keeps a
 * "next session" hint with an explicit restart instead of pretending a live
 * process can see the change.
 */
export function SubagentModelSheet({
  client,
  settings,
  running,
  online,
  onChanged,
  onClose,
  onNotice,
}: SubagentModelSheetProps) {
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [restarting, setRestarting] = useState(false)

  const pick = async (value: string | null): Promise<void> => {
    if (busy || !online) return
    if (value === settings.current) {
      onClose()
      return
    }
    setBusy(true)
    try {
      await client.setSubagentModel(value)
      onChanged(value)
      setChanged(true)
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
    } finally {
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (restarting) return
    setRestarting(true)
    try {
      await client.restartAgentProcess()
      onNotice(strings.subagentRestarting)
      onClose()
    } catch (error) {
      onNotice(commandErrorText(errorCode(error)))
      setConfirming(false)
    } finally {
      setRestarting(false)
    }
  }

  if (confirming) {
    return (
      <ConfirmActionSheet
        title={strings.subagentRestartTitle}
        body={strings.subagentRestartBody}
        confirmLabel={strings.subagentRestartConfirm}
        testId="subagent-restart-confirm"
        tone="danger"
        busy={restarting}
        onConfirm={() => void restart()}
        onCancel={() => setConfirming(false)}
      />
    )
  }

  const values: readonly (string | null)[] = [null, ...settings.candidates]

  return (
    <BottomSheet
      title={strings.subagentChipLabel}
      icon="👥"
      testId="subagent-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
      expandKey={settings.current ?? 'inherit'}
      footer={
        changed ? (
          <div className="subagent-restart-hint">
            <span>{strings.subagentNextSession}</span>
            <button
              type="button"
              data-testid="subagent-restart"
              disabled={restarting || !online}
              onClick={() => (running ? setConfirming(true) : void restart())}
            >
              {restarting ? strings.subagentRestarting : strings.subagentRestartNow}
            </button>
          </div>
        ) : undefined
      }
    >
      <p className="sheet__hint">{strings.subagentSheetDesc}</p>
      {settings.candidates.length === 0 && (
        <p className="sheet__hint">{strings.subagentEmptyCandidates}</p>
      )}
      <ul className="config-values">
        {values.map((value) => {
          const current = value === settings.current
          return (
            <li key={value ?? 'inherit'}>
              <button
                type="button"
                className={`config-value${current ? ' config-value--current' : ''}`}
                data-testid="subagent-value"
                data-value={value ?? 'inherit'}
                data-current={current ? 'true' : undefined}
                disabled={busy || !online}
                onClick={() => void pick(value)}
              >
                <span className="config-value__label">
                  {value === null ? strings.subagentInherit : value}
                </span>
                {current && <span className="config-value__check">{strings.configCurrent}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {!online && <p className="sheet__hint sheet__hint--danger">{strings.pendingOffline}</p>}
    </BottomSheet>
  )
}
