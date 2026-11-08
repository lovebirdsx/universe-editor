import { useEffect } from 'react'
import type { StoredCredentials } from '../credentials.js'
import { strings } from '../strings.js'

export interface SettingsDrawerProps {
  readonly credentials: StoredCredentials
  readonly onClose: () => void
  readonly onUnpair: () => void
}

export function SettingsDrawer({ credentials, onClose, onUnpair }: SettingsDrawerProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="settings-title" className="drawer__title">
          {strings.settingsTitle}
        </h2>
        <dl className="drawer__details">
          <dt>{strings.settingsDeviceName}</dt>
          <dd>{credentials.deviceName}</dd>
          <dt>{strings.settingsDeviceId}</dt>
          <dd className="drawer__mono">{credentials.deviceId.slice(0, 8)}</dd>
          <dt>{strings.settingsPcName}</dt>
          <dd>{credentials.pcName}</dd>
        </dl>
        <p className="drawer__hint">{strings.settingsUnpairHint}</p>
        <button type="button" className="button button--danger" onClick={onUnpair}>
          {strings.settingsUnpair}
        </button>
        <button type="button" className="button button--secondary" onClick={onClose}>
          {strings.settingsClose}
        </button>
      </aside>
    </div>
  )
}
