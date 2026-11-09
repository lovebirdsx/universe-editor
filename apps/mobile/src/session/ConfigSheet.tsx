import type { MobileConfigOption } from '@universe-editor/mobile-protocol'
import { useState } from 'react'
import { BottomSheet } from '../components/BottomSheet.js'
import type { MobileClient } from '../state/mobileClient.js'
import { commandErrorText, strings } from '../strings.js'
import { errorCode } from '../errors.js'

export interface ConfigSheetProps {
  readonly client: Pick<MobileClient, 'setConfigOption'>
  readonly option: MobileConfigOption
  readonly online: boolean
  readonly onClose: () => void
  readonly onNotice: (text: string) => void
}

/** Picker for one select config option; high-risk values stay visible but inert. */
export function ConfigSheet({ client, option, online, onClose, onNotice }: ConfigSheetProps) {
  const [busyValue, setBusyValue] = useState<string | undefined>(undefined)
  const values = option.options ?? []

  const choose = async (value: string): Promise<void> => {
    if (busyValue !== undefined) return
    setBusyValue(value)
    try {
      await client.setConfigOption(option.id, value)
      onClose()
    } catch (error) {
      setBusyValue(undefined)
      onNotice(commandErrorText(errorCode(error)))
    }
  }

  return (
    <BottomSheet
      title={option.name}
      icon="⚙"
      testId="config-sheet"
      tone="neutral"
      overlay
      onDismiss={onClose}
      expandKey={option.id}
    >
      {values.length === 0 ? (
        <p className="sheet__hint">{strings.configNeedsPc}</p>
      ) : (
        <ul className="config-values">
          {values.map((value) => {
            const current = value.label === option.currentValue
            const blocked = value.allowedOnMobile === false
            return (
              <li key={value.value}>
                <button
                  type="button"
                  className={`config-value${current ? ' config-value--current' : ''}`}
                  data-testid="config-value"
                  data-value={value.value}
                  data-current={current ? 'true' : undefined}
                  disabled={blocked || !online || busyValue !== undefined}
                  onClick={() => void choose(value.value)}
                >
                  <span className="config-value__label">{value.label}</span>
                  {current && <span className="config-value__check">{strings.configCurrent}</span>}
                  {blocked && (
                    <span className="config-value__blocked">{strings.configNeedsPc}</span>
                  )}
                  {busyValue === value.value && (
                    <span className="config-value__blocked">{strings.configSwitching}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!online && <p className="sheet__hint sheet__hint--danger">{strings.pendingOffline}</p>}
    </BottomSheet>
  )
}
