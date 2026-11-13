/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mobile Devices settings page tests: status rendering, config writes, the
 *  pairing lifecycle (show → device appears → close, expiry → regenerate),
 *  revoke confirmation and the disabled state while the gateway is down.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  ICommandService,
  IDialogService,
  IOpenerService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import {
  DEFAULT_MOBILE_GATEWAY_CONFIG,
  IMobileGatewayService,
  type MobileAuditEntry,
  type MobileDeviceInfo,
  type MobileGatewayConfigPatch,
  type MobileGatewayConfigState,
  type MobileGatewayConfigUpdateResult,
  type MobileGatewayStatus,
  type MobilePairingSession,
} from '../../../../shared/ipc/mobileGatewayService.js'
import { MobileDevicesEditor } from '../MobileDevicesEditor.js'
import { ServicesContext } from '../../useService.js'

vi.mock('qrcode', () => ({
  default: {
    toString: vi.fn(async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// Generic RFC 1918 fixtures for the LAN address picker; not this machine's network.
const LAN_ADDRESS = '192.168.1.20' // sensitive-strings:allow
const ALT_LAN_ADDRESS = '10.0.0.5' // sensitive-strings:allow

const RUNNING_STATUS: MobileGatewayStatus = {
  state: 'running',
  listenAddress: '127.0.0.1:47321',
  lanAddresses: [LAN_ADDRESS],
  origins: ['http://127.0.0.1:47321', 'https://pc.example.ts.net'],
  insecure: false,
  bind: 'loopback',
  capabilities: { installable: true, push: true },
  connectedDeviceCount: 1,
  supportsLaunchAtLogin: true,
}

const STOPPED_STATUS: MobileGatewayStatus = {
  state: 'stopped',
  lanAddresses: [LAN_ADDRESS],
  origins: [],
  insecure: false,
  bind: 'loopback',
  capabilities: { installable: false, push: false },
  connectedDeviceCount: 0,
  supportsLaunchAtLogin: false,
}

const DEVICE: MobileDeviceInfo = {
  deviceId: 'd1',
  name: 'Alice Phone',
  platform: 'ios',
  createdAt: Date.UTC(2026, 0, 2, 10, 30),
  lastSeenAt: Date.UTC(2026, 0, 3, 9, 0),
  connected: true,
  notificationsEnabled: false,
}

const PAIRING: MobilePairingSession = {
  code: 'ABCD-2345',
  expiresAt: Date.now() + 120_000,
  pairUrls: [
    'http://127.0.0.1:47321/pair#code=ABCD2345',
    'https://pc.example.ts.net/pair#code=ABCD2345',
  ],
}

class FakeMobileGatewayService {
  declare readonly _serviceBrand: undefined

  status: MobileGatewayStatus = RUNNING_STATUS
  devices: readonly MobileDeviceInfo[] = []
  audit: readonly MobileAuditEntry[] = []
  pairing: MobilePairingSession = PAIRING
  configState: MobileGatewayConfigState = { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG } }

  private readonly _onDidChangeStatus = new Emitter<MobileGatewayStatus>()
  private readonly _onDidChangeDevices = new Emitter<readonly MobileDeviceInfo[]>()
  private readonly _onDidChangeConfig = new Emitter<MobileGatewayConfigState>()
  readonly onDidChangeStatus = this._onDidChangeStatus.event
  readonly onDidChangeDevices = this._onDidChangeDevices.event
  readonly onDidChangeConfig = this._onDidChangeConfig.event

  getStatus = vi.fn(async () => this.status)
  startPairing = vi.fn(async () => this.pairing)
  cancelPairing = vi.fn(async () => undefined)
  listDevices = vi.fn(async () => this.devices)
  revokeDevice = vi.fn(async () => undefined)
  getRecentAudit = vi.fn(async () => this.audit)

  getConfig = vi.fn(async () => this.configState)

  updateConfig = vi.fn(
    async (patch: MobileGatewayConfigPatch): Promise<MobileGatewayConfigUpdateResult> => {
      const state: MobileGatewayConfigState = {
        config: { ...this.configState.config, ...patch },
        ...(this.configState.error !== undefined ? { error: this.configState.error } : {}),
      }
      this.configState = state
      this._onDidChangeConfig.fire(state)
      return { ok: true, state }
    },
  )

  getConfigFileUri = vi.fn(async () => 'file:///tmp/userData/mobile/gateway.json')
  ensureConfigFile = vi.fn(async () => 'file:///tmp/userData/mobile/gateway.json')

  emitDevices(next: readonly MobileDeviceInfo[]): void {
    this.devices = next
    this._onDidChangeDevices.fire(next)
  }

  emitConfig(next: MobileGatewayConfigState): void {
    this.configState = next
    this._onDidChangeConfig.fire(next)
  }
}

function renderEditor(
  options: {
    status?: MobileGatewayStatus
    devices?: readonly MobileDeviceInfo[]
    audit?: readonly MobileAuditEntry[]
    config?: MobileGatewayConfigState
  } = {},
) {
  const gateway = new FakeMobileGatewayService()
  gateway.status = options.status ?? RUNNING_STATUS
  gateway.devices = options.devices ?? []
  gateway.audit = options.audit ?? []
  gateway.configState = options.config ?? { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG } }

  const dialog = { confirm: vi.fn(async () => ({ confirmed: true })) }
  const commands = { executeCommand: vi.fn(async () => undefined) }
  const open = vi.fn(async () => true)
  const opener = {
    _serviceBrand: undefined,
    registerOpener: vi.fn(() => ({ dispose: (): void => undefined })),
    open,
  } as unknown as IOpenerService

  const services = new ServiceCollection()
  services.set(IMobileGatewayService, gateway as unknown as IMobileGatewayService)
  services.set(IDialogService, dialog as unknown as IDialogService)
  services.set(ICommandService, commands as unknown as ICommandService)
  services.set(IOpenerService, opener)
  const container = new InstantiationService(services)

  const utils = render(<MobileDevicesEditor />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={container}>{children}</ServicesContext.Provider>
    ),
  })

  return { ...utils, gateway, dialog, commands, open }
}

async function flush(): Promise<void> {
  await act(async () => {})
}

describe('MobileDevicesEditor', () => {
  it('renders the live gateway status, capabilities and connection count', async () => {
    renderEditor()
    await screen.findByTestId('mobile-gateway-state')

    expect(screen.getByTestId('mobile-gateway-state').textContent).toBe('Running')
    expect(screen.getByTestId('mobile-gateway-listen').textContent).toBe('127.0.0.1:47321')
    expect(screen.getByTestId('mobile-gateway-connected').textContent).toContain('1 connected')
    expect(screen.queryByTestId('mobile-gateway-insecure')).toBeNull()
    expect(screen.getAllByText('Available')).toHaveLength(2)
  })

  it('opens the loopback origin in the PC browser from the gateway section', async () => {
    const { open } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')

    fireEvent.click(screen.getByTestId('mobile-gateway-open-browser'))

    expect(open).toHaveBeenCalledWith('http://127.0.0.1:47321', { fromUserGesture: true })
  })

  it('opens the LAN HTTPS origin when the gateway is bound to a LAN address', async () => {
    const { open } = renderEditor({
      status: {
        ...RUNNING_STATUS,
        bind: 'lan',
        listenAddress: '192.0.2.20:47321',
        origins: ['https://192.0.2.20:47321'],
      },
    })
    await screen.findByTestId('mobile-gateway-state')

    fireEvent.click(screen.getByTestId('mobile-gateway-open-browser'))

    expect(open).toHaveBeenCalledWith('https://192.0.2.20:47321', { fromUserGesture: true })
  })

  it('flags a clear-text non-loopback binding', async () => {
    renderEditor({
      status: { ...RUNNING_STATUS, insecure: true, bind: 'lan', listenAddress: '192.0.2.20:47321' },
    })
    await screen.findByTestId('mobile-gateway-state')
    expect(screen.getByTestId('mobile-gateway-insecure')).toBeTruthy()
  })

  it('warns when a phone rejected the gateway certificate', async () => {
    renderEditor({
      status: {
        ...RUNNING_STATUS,
        bind: 'lan',
        listenAddress: '192.0.2.20:47321',
        origins: ['https://192.0.2.20:47321'],
        tlsTrustWarning: { at: Date.UTC(2026, 0, 3, 9, 0), remoteAddress: '192.0.2.30' },
      },
    })
    await screen.findByTestId('mobile-gateway-state')

    const warning = screen.getByTestId('mobile-gateway-tls-trust-warning')
    expect(warning.textContent).toContain('certificate_unknown')
    expect(warning.textContent).toContain('192.0.2.30')
  })

  it('updates the gateway config through the service', async () => {
    const { gateway } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    fireEvent.click(screen.getByTestId('mobile-gateway-enabled'))

    expect(gateway.updateConfig).toHaveBeenCalledWith({ enabled: true })
    await flush()
    expect(screen.getByTestId('mobile-gateway-enabled').getAttribute('aria-checked')).toBe('true')
  })

  it('updates the background mode toggles through the service', async () => {
    const { gateway } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    fireEvent.click(screen.getByTestId('mobile-gateway-keep-running'))
    expect(gateway.updateConfig).toHaveBeenCalledWith({ keepRunningInBackground: true })
    await flush()
    expect(screen.getByTestId('mobile-gateway-keep-running').getAttribute('aria-checked')).toBe(
      'true',
    )

    fireEvent.click(screen.getByTestId('mobile-gateway-launch-at-login'))
    expect(gateway.updateConfig).toHaveBeenCalledWith({ launchAtLogin: true })
    await flush()
    expect(screen.getByTestId('mobile-gateway-launch-at-login').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  it('disables launch at login when the build cannot register a login item', async () => {
    renderEditor({ status: { ...RUNNING_STATUS, supportsLaunchAtLogin: false } })
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    const toggle = screen.getByTestId('mobile-gateway-launch-at-login') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(screen.getByTestId('mobile-gateway-launch-at-login-unsupported').textContent).toContain(
      'installed Windows / macOS',
    )
  })

  it('updates the bind mode through the service', async () => {
    const { gateway } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    fireEvent.click(screen.getByTestId('mobile-gateway-bind'))
    fireEvent.click(await screen.findByRole('option', { name: 'LAN address' }))

    expect(gateway.updateConfig).toHaveBeenCalledWith({ bind: 'lan' })
  })

  it('picks a specific LAN address from the detected candidates', async () => {
    const { gateway } = renderEditor({
      status: {
        ...RUNNING_STATUS,
        bind: 'lan',
        listenAddress: `${LAN_ADDRESS}:47321`,
        lanAddresses: [LAN_ADDRESS, ALT_LAN_ADDRESS],
      },
      config: { config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, bind: 'lan' } },
    })
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    expect(screen.getByTestId('mobile-gateway-lan-address').textContent).toContain(
      `Automatic (${LAN_ADDRESS})`,
    )
    fireEvent.click(screen.getByTestId('mobile-gateway-lan-address'))
    fireEvent.click(await screen.findByRole('option', { name: ALT_LAN_ADDRESS }))

    expect(gateway.updateConfig).toHaveBeenCalledWith({ lanAddress: ALT_LAN_ADDRESS })
  })

  it('rolls back and shows an error when saving the config fails', async () => {
    const { gateway } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')
    await flush()
    gateway.updateConfig.mockResolvedValueOnce({
      ok: false,
      state: gateway.configState,
      errors: ['"port" must be an integer between 1 and 65535'],
    })

    fireEvent.click(screen.getByTestId('mobile-gateway-enabled'))
    await flush()

    expect(await screen.findByTestId('mobile-gateway-config-error')).toBeTruthy()
    expect(screen.getByTestId('mobile-gateway-enabled').getAttribute('aria-checked')).toBe('false')
  })

  it('surfaces a gateway config file parse error', async () => {
    renderEditor({
      config: {
        config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG },
        error: 'gateway.json is not valid JSON (offset 3)',
      },
    })
    await screen.findByTestId('mobile-gateway-state')

    const error = await screen.findByTestId('mobile-gateway-config-error')
    expect(error.textContent).toContain('gateway.json is not valid JSON')
  })

  it('opens the gateway config JSON command', async () => {
    const { commands } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')
    await flush()

    fireEvent.click(screen.getByTestId('mobile-gateway-open-config-json'))

    expect(commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.mobile.openGatewayConfigJson',
    )
  })

  it('pairs a device, then collapses the QR when the new device appears', async () => {
    const { gateway } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pairing-start'))
    })

    expect(gateway.startPairing).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('mobile-pairing-code').textContent).toBe('ABCD-2345')
    expect(await screen.findByTestId('mobile-pairing-qr')).toBeTruthy()
    // The HTTPS origin is preferred even though the loopback URL is listed first.
    expect(
      screen
        .getByRole('button', { name: 'https://pc.example.ts.net' })
        .getAttribute('aria-pressed'),
    ).toBe('true')

    act(() => gateway.emitDevices([DEVICE]))

    expect(await screen.findByTestId('mobile-pairing-success')).toBeTruthy()
    expect(screen.queryByTestId('mobile-pairing-qr')).toBeNull()
    expect(screen.getByTestId('mobile-device-d1')).toBeTruthy()
  })

  it('opens the selected pairing URL in the PC browser and follows the origin switch', async () => {
    const { open } = renderEditor()
    await screen.findByTestId('mobile-gateway-state')

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pairing-start'))
    })

    fireEvent.click(screen.getByTestId('mobile-pairing-open-browser'))
    expect(open).toHaveBeenLastCalledWith('https://pc.example.ts.net/pair#code=ABCD2345', {
      fromUserGesture: true,
    })

    fireEvent.click(screen.getByRole('button', { name: 'http://127.0.0.1:47321' }))
    fireEvent.click(screen.getByTestId('mobile-pairing-open-browser'))
    expect(open).toHaveBeenLastCalledWith('http://127.0.0.1:47321/pair#code=ABCD2345', {
      fromUserGesture: true,
    })
  })

  it('expires a pairing code and regenerates it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))

    const { gateway } = renderEditor()
    gateway.pairing = {
      ...PAIRING,
      expiresAt: Date.now() + 120_000,
    }
    await flush()

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pairing-start'))
    })
    expect(screen.getByTestId('mobile-pairing-code').textContent).toBe('ABCD-2345')

    act(() => {
      vi.advanceTimersByTime(120_001)
    })
    expect(screen.getByTestId('mobile-pairing-expired')).toBeTruthy()
    expect(screen.queryByTestId('mobile-pairing-qr')).toBeNull()

    gateway.pairing = { ...gateway.pairing, expiresAt: Date.now() + 120_000 }
    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-pairing-regenerate'))
    })

    expect(gateway.startPairing).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('mobile-pairing-code').textContent).toBe('ABCD-2345')
  })

  it('asks for confirmation before revoking a device', async () => {
    const { gateway, dialog } = renderEditor({ devices: [DEVICE] })
    await screen.findByTestId('mobile-device-d1')

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-device-revoke-d1'))
    })

    expect(dialog.confirm).toHaveBeenCalledTimes(1)
    expect(gateway.revokeDevice).toHaveBeenCalledWith('d1')
  })

  it('does not revoke when the confirmation is dismissed', async () => {
    const { gateway, dialog } = renderEditor({ devices: [DEVICE] })
    dialog.confirm.mockResolvedValue({ confirmed: false })
    await screen.findByTestId('mobile-device-d1')

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-device-revoke-d1'))
    })

    expect(gateway.revokeDevice).not.toHaveBeenCalled()
  })

  it('disables pairing while the gateway is not running', async () => {
    renderEditor({ status: STOPPED_STATUS })
    await screen.findByTestId('mobile-gateway-state')

    const button = screen.getByTestId('mobile-pairing-start') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.queryByTestId('mobile-gateway-open-browser')).toBeNull()
    expect(screen.getByText('Turn on the gateway before pairing a device.')).toBeTruthy()
  })

  it('loads the recent audit trail when the section is expanded', async () => {
    renderEditor({
      audit: [
        {
          ts: Date.UTC(2026, 0, 3, 9, 0),
          deviceName: 'Alice Phone',
          action: 'pair_attempt',
          result: 'success',
        },
      ],
    })
    await screen.findByTestId('mobile-gateway-state')

    fireEvent.click(screen.getByTestId('mobile-audit-toggle'))

    expect(await screen.findByTestId('mobile-audit-row')).toBeTruthy()
    expect(screen.getByText('Pairing attempt')).toBeTruthy()
    expect(screen.getByText('Alice Phone')).toBeTruthy()
  })
})
