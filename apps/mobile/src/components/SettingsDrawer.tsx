import { useEffect, useRef, useState } from 'react'
import type { MobileAttentionKind, MobileNotificationPrefs } from '@universe-editor/mobile-protocol'
import type { StoredCredentials } from '../credentials.js'
import {
  detectNotificationCapability,
  enablePushNotifications,
  toWireSubscription,
  type NotificationCapability,
  type PushRegistrationLike,
} from '../notifications/pushNotifications.js'
import type { MobileClient } from '../state/mobileClient.js'
import { strings } from '../strings.js'

export interface SettingsDrawerProps {
  readonly client: MobileClient
  readonly credentials: StoredCredentials
  readonly onClose: () => void
  readonly onUnpair: () => void
}

const ALL_KINDS: readonly MobileAttentionKind[] = ['permission', 'question', 'completed', 'errored']

const KIND_LABELS: Readonly<Record<MobileAttentionKind, string>> = {
  permission: strings.notificationsKindPermission,
  question: strings.notificationsKindQuestion,
  completed: strings.notificationsKindCompleted,
  errored: strings.notificationsKindErrored,
}

type PushState = 'unknown' | 'disabled' | 'enabled'

export function SettingsDrawer({ client, credentials, onClose, onUnpair }: SettingsDrawerProps) {
  const [capability] = useState<NotificationCapability>(() => detectNotificationCapability())
  const [pushState, setPushState] = useState<PushState>('unknown')
  const [busy, setBusy] = useState(false)
  const [kinds, setKinds] = useState<readonly MobileAttentionKind[]>(ALL_KINDS)
  const [alwaysNotify, setAlwaysNotify] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Detect an existing browser subscription on open and make sure the gateway
  // knows about it after a page reload.
  useEffect(() => {
    if (capability.blocker !== undefined || !capability.pushSupported) {
      setPushState('disabled')
      return
    }
    let cancelled = false
    void serviceWorkerPushManager()
      .then(async (manager) => {
        if (manager === undefined) return
        const existing = await manager.getSubscription().catch(() => null)
        if (cancelled || existing === null) {
          if (!cancelled) setPushState('disabled')
          return
        }
        const wire = toWireSubscription(existing)
        if (wire !== undefined) client.subscribePush(wire)
        if (!cancelled) setPushState('enabled')
      })
      .catch(() => {
        if (!cancelled) setPushState('disabled')
      })
    return () => {
      cancelled = true
    }
  }, [capability, client])

  const enable = async (): Promise<void> => {
    setError(undefined)
    if (capability.blocker !== undefined) return
    const applicationServerKey = client.getVapidPublicKey()
    if (applicationServerKey === undefined) {
      setError(strings.notificationsNoVapid)
      return
    }
    setBusy(true)
    const registration = navigator.serviceWorker.ready as unknown as Promise<PushRegistrationLike>
    const result = await enablePushNotifications({
      permission: typeof Notification === 'undefined' ? 'default' : Notification.permission,
      requestPermission: () =>
        typeof Notification === 'undefined'
          ? Promise.resolve('denied')
          : Notification.requestPermission(),
      registration,
      applicationServerKey,
    })
    if (!mountedRef.current) return
    setBusy(false)
    if (!result.ok) {
      setPushState('disabled')
      setError(
        result.reason === 'denied' ? strings.notificationsDenied : strings.notificationsFailed,
      )
      return
    }
    const prefs: MobileNotificationPrefs = {
      enabled: true,
      kinds,
      alwaysNotify,
    }
    client.subscribePush(result.subscription, prefs)
    setPushState('enabled')
    setBusy(false)
  }

  const disable = async (): Promise<void> => {
    setError(undefined)
    setBusy(true)
    try {
      const manager = await serviceWorkerPushManager()
      const existing = await manager?.getSubscription().catch(() => null)
      await existing?.unsubscribe?.()
    } catch {
      // The gateway subscription is cleared below regardless.
    }
    client.unsubscribePush()
    client.setNotificationPrefs(false, kinds, alwaysNotify)
    if (mountedRef.current) {
      setBusy(false)
      setPushState('disabled')
    }
  }

  const updateKinds = (kind: MobileAttentionKind, checked: boolean): void => {
    const next = checked
      ? ALL_KINDS.filter((candidate) => candidate === kind || kinds.includes(candidate))
      : kinds.filter((candidate) => candidate !== kind)
    setKinds(next)
    if (pushState === 'enabled') client.setNotificationPrefs(true, next, alwaysNotify)
  }

  const updateAlwaysNotify = (next: boolean): void => {
    setAlwaysNotify(next)
    if (pushState === 'enabled') client.setNotificationPrefs(true, kinds, next)
  }

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

        <section className="drawer__section" data-testid="notification-settings">
          <h3 className="drawer__sectionTitle">{strings.notificationsSection}</h3>
          <p className="drawer__hint">{strings.notificationsHint}</p>

          <dl className="drawer__details">
            <dt>{strings.notificationsCapabilitySecure}</dt>
            <dd>
              {capability.secureContext
                ? strings.notificationsCapabilityYes
                : strings.notificationsCapabilityNo}
            </dd>
            <dt>{strings.notificationsCapabilityPush}</dt>
            <dd>
              {capability.pushSupported
                ? strings.notificationsCapabilityYes
                : strings.notificationsCapabilityNo}
            </dd>
            <dt>{strings.notificationsCapabilityStandalone}</dt>
            <dd data-testid="notification-standalone">
              {capability.standalone
                ? strings.notificationsCapabilityYes
                : strings.notificationsCapabilityNo}
            </dd>
          </dl>

          {capability.blocker !== undefined && (
            <p className="drawer__hint" data-testid="notification-guidance">
              {guidanceFor(capability)}
            </p>
          )}

          {capability.blocker === undefined && (
            <>
              {pushState === 'enabled' ? (
                <>
                  <p data-testid="notification-enabled">{strings.notificationsEnabled}</p>
                  <div
                    className="drawer__kinds"
                    role="group"
                    aria-label={strings.notificationsKindsLabel}
                  >
                    <span className="drawer__fieldLabel">{strings.notificationsKindsLabel}</span>
                    {ALL_KINDS.map((kind) => (
                      <label key={kind} className="drawer__checkbox">
                        <input
                          type="checkbox"
                          checked={kinds.includes(kind)}
                          onChange={(event) => updateKinds(kind, event.currentTarget.checked)}
                          data-testid={`notification-kind-${kind}`}
                        />
                        <span>{KIND_LABELS[kind]}</span>
                      </label>
                    ))}
                  </div>
                  <label className="drawer__checkbox">
                    <input
                      type="checkbox"
                      checked={alwaysNotify}
                      onChange={(event) => updateAlwaysNotify(event.currentTarget.checked)}
                      data-testid="notification-always"
                    />
                    <span>{strings.notificationsAlwaysNotify}</span>
                  </label>
                  <p className="drawer__hint">{strings.notificationsAlwaysNotifyHint}</p>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => void disable()}
                    disabled={busy}
                    data-testid="notification-disable"
                  >
                    {busy ? strings.notificationsDisabling : strings.notificationsDisable}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void enable()}
                  disabled={busy || pushState === 'unknown'}
                  data-testid="notification-enable"
                >
                  {busy ? strings.notificationsEnabling : strings.notificationsEnable}
                </button>
              )}
              {error !== undefined && (
                <p className="drawer__error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </section>

        <button type="button" className="button button--secondary" onClick={onClose}>
          {strings.settingsClose}
        </button>
      </aside>
    </div>
  )
}

function guidanceFor(capability: NotificationCapability): string {
  switch (capability.blocker) {
    case 'insecure':
      return strings.notificationsUnsupportedInsecure
    case 'notification-unsupported':
      return strings.notificationsUnsupportedNotification
    case 'push-unsupported':
      return strings.notificationsUnsupportedPush
    case 'ios-not-standalone':
      return strings.notificationsUnsupportedIos
    default:
      return ''
  }
}

async function serviceWorkerPushManager(): Promise<
  PushRegistrationLike['pushManager'] | undefined
> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
  try {
    const registration = (await navigator.serviceWorker.ready) as unknown as PushRegistrationLike
    return registration.pushManager
  } catch {
    return undefined
  }
}
