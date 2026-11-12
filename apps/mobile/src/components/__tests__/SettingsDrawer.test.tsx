import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  MobileAttentionKind,
  MobileNotificationPrefs,
  MobilePushSubscription,
} from '@universe-editor/mobile-protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import type { MobileClient } from '../../state/mobileClient.js'
import type { SocketState } from '../../socket/mobileSocket.js'
import { Store } from '../../state/store.js'
import { SESSION_DISPLAY_STORAGE_KEY } from '../../session/sessionDisplay.js'
import {
  SESSION_CLOSE_CONFIRM_STORAGE_KEY,
  SESSION_REMOVE_CONFIRM_STORAGE_KEY,
} from '../../session/sessionConfirm.js'
import { THEME_META_COLORS, THEME_STORAGE_KEY } from '../../theme.js'
import { SettingsDrawer } from '../SettingsDrawer.js'
import { strings } from '../../strings.js'

const credentials: StoredCredentials = {
  deviceId: 'device-1',
  token: 'token-1',
  pcName: 'PC-A',
  deviceName: 'Phone',
  platform: 'other',
  protocolVersion: 5,
}

interface DrawerHarness {
  readonly client: MobileClient
  readonly prefsStore: Store<MobileNotificationPrefs | undefined>
  readonly socketStore: Store<SocketState>
  readonly setNotificationPrefs: ReturnType<typeof vi.fn>
}

interface DrawerOptions {
  readonly prefs?: MobileNotificationPrefs
  readonly socketState?: SocketState
}

function createDrawerClient(trusted: boolean, options: DrawerOptions = {}): DrawerHarness {
  const prefsStore = new Store<MobileNotificationPrefs | undefined>(options.prefs)
  const socketStore = new Store<SocketState>(options.socketState ?? 'connected')
  const setNotificationPrefs = vi.fn(
    (
      enabled: boolean,
      kinds: readonly MobileAttentionKind[] | undefined,
      alwaysNotify: boolean,
    ) => {
      prefsStore.setState({
        enabled,
        ...(kinds !== undefined ? { kinds } : {}),
        alwaysNotify,
      })
    },
  )
  const client = {
    subscribePush: vi.fn(
      (_subscription: MobilePushSubscription, prefs?: MobileNotificationPrefs) => {
        if (prefs !== undefined) prefsStore.setState(prefs)
      },
    ),
    unsubscribePush: vi.fn(),
    setNotificationPrefs,
    getVapidPublicKey: () => undefined,
    getConnectionDiagnosisStore: () => ({
      getState: () => undefined,
      subscribe: () => () => undefined,
    }),
    getDeviceTrustedStore: () => ({
      getState: () => trusted,
      subscribe: () => () => undefined,
    }),
    getNotificationPrefsStore: () => prefsStore,
    getSocketStateStore: () => socketStore,
    retryDiagnosis: vi.fn(),
    retryConnection: vi.fn(),
  } as unknown as MobileClient
  return { client, prefsStore, socketStore, setNotificationPrefs }
}

function renderWithClient(client: MobileClient): void {
  render(
    <SettingsDrawer
      client={client}
      credentials={credentials}
      onClose={() => undefined}
      onUnpair={() => undefined}
    />,
  )
}

function renderDrawer(trusted = false, options: DrawerOptions = {}): DrawerHarness {
  const harness = createDrawerClient(trusted, options)
  renderWithClient(harness.client)
  return harness
}

describe('SettingsDrawer preferences', () => {
  let meta: HTMLMetaElement

  beforeEach(() => {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.append(meta)
  })

  afterEach(() => {
    meta.remove()
  })

  it('defaults to system theme and only-message display', () => {
    renderDrawer()

    expect((screen.getByTestId('theme-system') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('session-display-onlyMessage') as HTMLInputElement).checked).toBe(
      true,
    )
  })

  it('shows whether the PC trusts this device', () => {
    renderDrawer(true)
    expect(screen.getByText(strings.settingsDeviceTrustedOn)).toBeTruthy()

    cleanup()
    renderDrawer(false)
    expect(screen.getByText(strings.settingsDeviceTrustedOff)).toBeTruthy()
  })

  it('applies and persists the selected theme', () => {
    renderDrawer()

    fireEvent.click(screen.getByTestId('theme-dark'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(meta.getAttribute('content')).toBe(THEME_META_COLORS.dark)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    fireEvent.click(screen.getByTestId('theme-light'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('reads stored values and persists the display mode', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    localStorage.setItem(SESSION_DISPLAY_STORAGE_KEY, 'full')
    renderDrawer()

    expect((screen.getByTestId('theme-light') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('session-display-full') as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByTestId('session-display-onlyMessage'))
    expect(localStorage.getItem(SESSION_DISPLAY_STORAGE_KEY)).toBe('onlyMessage')
  })

  it('defaults to asking before closing and removing sessions', () => {
    renderDrawer()

    expect((screen.getByTestId('session-confirm-close') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('session-confirm-remove') as HTMLInputElement).checked).toBe(true)
  })

  it('reflects stored session confirm preferences independently', () => {
    localStorage.setItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY, 'never')
    renderDrawer()

    expect((screen.getByTestId('session-confirm-close') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('session-confirm-remove') as HTMLInputElement).checked).toBe(true)
  })

  it('persists each session confirm preference without touching the other', () => {
    renderDrawer()

    fireEvent.click(screen.getByTestId('session-confirm-close'))
    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('never')
    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBeNull()

    fireEvent.click(screen.getByTestId('session-confirm-remove'))
    expect(localStorage.getItem(SESSION_REMOVE_CONFIRM_STORAGE_KEY)).toBe('never')
    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('never')

    fireEvent.click(screen.getByTestId('session-confirm-close'))
    expect(localStorage.getItem(SESSION_CLOSE_CONFIRM_STORAGE_KEY)).toBe('ask')
  })

  it('explains fullscreen availability when the browser cannot go fullscreen', () => {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false })
    renderDrawer()

    expect(screen.getByTestId('fullscreen-unsupported')).toBeTruthy()
    expect(screen.queryByTestId('fullscreen-toggle')).toBeNull()

    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled
  })
})

describe('SettingsDrawer notification preferences', () => {
  const restores: Array<() => void> = []

  function define(target: object, key: string, value: unknown): void {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    Object.defineProperty(target, key, { configurable: true, value })
    restores.push(() => {
      if (descriptor === undefined) Reflect.deleteProperty(target, key)
      else Object.defineProperty(target, key, descriptor)
    })
  }

  beforeEach(() => {
    define(window, 'isSecureContext', true)
    define(window, 'Notification', {
      permission: 'granted',
      requestPermission: async () => 'granted',
    })
    define(window, 'PushManager', class {})
    define(navigator, 'serviceWorker', {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => ({
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/fcm/send/token',
              keys: { p256dh: 'p256dh', auth: 'auth' },
            }),
          }),
        },
      }),
    })
  })

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.()
  })

  async function renderNotificationDrawer(options: DrawerOptions = {}): Promise<DrawerHarness> {
    const harness = renderDrawer(false, options)
    await screen.findByTestId('notification-always')
    return harness
  }

  it('hydrates kinds and alwaysNotify from the saved preferences', async () => {
    await renderNotificationDrawer({
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })

    expect((screen.getByTestId('notification-kind-permission') as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByTestId('notification-kind-question') as HTMLInputElement).checked).toBe(
      false,
    )
    expect((screen.getByTestId('notification-always') as HTMLInputElement).checked).toBe(true)
  })

  it('keeps the hydrated alwaysNotify when toggling a kind', async () => {
    const harness = await renderNotificationDrawer({
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })

    fireEvent.click(screen.getByTestId('notification-kind-completed'))

    expect(harness.setNotificationPrefs).toHaveBeenLastCalledWith(
      true,
      ['permission', 'completed'],
      true,
    )
  })

  it('keeps the hydrated kinds when toggling alwaysNotify', async () => {
    const harness = await renderNotificationDrawer({
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })

    fireEvent.click(screen.getByTestId('notification-always'))

    expect(harness.setNotificationPrefs).toHaveBeenLastCalledWith(true, ['permission'], false)
  })

  it('keeps the preference after closing and reopening the drawer', async () => {
    const harness = await renderNotificationDrawer({
      prefs: { enabled: true, kinds: ['permission'], alwaysNotify: true },
    })
    cleanup()

    renderWithClient(harness.client)
    await screen.findByTestId('notification-always')

    expect((screen.getByTestId('notification-kind-permission') as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByTestId('notification-always') as HTMLInputElement).checked).toBe(true)
  })

  it('applies preferences that arrive after the drawer mounts', async () => {
    const harness = await renderNotificationDrawer()

    expect((screen.getByTestId('notification-always') as HTMLInputElement).checked).toBe(false)
    act(() => {
      harness.prefsStore.setState({ enabled: true, kinds: ['question'], alwaysNotify: true })
    })

    expect((screen.getByTestId('notification-kind-question') as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByTestId('notification-always') as HTMLInputElement).checked).toBe(true)
  })

  it('disables the controls until the connection says defaults are authoritative', async () => {
    const harness = await renderNotificationDrawer({ socketState: 'connecting' })

    expect((screen.getByTestId('notification-always') as HTMLInputElement).disabled).toBe(true)
    act(() => harness.socketStore.setState('connected'))
    expect((screen.getByTestId('notification-always') as HTMLInputElement).disabled).toBe(false)
  })
})
