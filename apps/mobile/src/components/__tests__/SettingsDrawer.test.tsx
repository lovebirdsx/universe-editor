import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredCredentials } from '../../credentials.js'
import type { MobileClient } from '../../state/mobileClient.js'
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

function renderDrawer(trusted = false): void {
  const client = {
    subscribePush: vi.fn(),
    unsubscribePush: vi.fn(),
    setNotificationPrefs: vi.fn(),
    getVapidPublicKey: () => undefined,
    getConnectionDiagnosisStore: () => ({
      getState: () => undefined,
      subscribe: () => () => undefined,
    }),
    getDeviceTrustedStore: () => ({
      getState: () => trusted,
      subscribe: () => () => undefined,
    }),
    retryDiagnosis: vi.fn(),
    retryConnection: vi.fn(),
  } as unknown as MobileClient
  render(
    <SettingsDrawer
      client={client}
      credentials={credentials}
      onClose={() => undefined}
      onUnpair={() => undefined}
    />,
  )
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
