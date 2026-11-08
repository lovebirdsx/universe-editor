/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mobile Devices — the PC-side settings editor for the phone gateway. It is a
 *  thin view over IMobileGatewayService: gateway switch + live status, listen
 *  mode, pairing (QR + one-time code + countdown), paired devices with revoke,
 *  and the recent audit trail. All state transitions live in mobileDevicesHooks.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileJson,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import {
  ICommandService,
  IConfigurationService,
  IDialogService,
  IOpenerService,
  localize,
} from '@universe-editor/platform'
import {
  Badge,
  Button,
  Select,
  Spinner,
  Toggle,
  cx,
  type SelectOption,
} from '@universe-editor/workbench-ui'
import { formatPairCode } from '@universe-editor/mobile-protocol'
import {
  IMobileGatewayService,
  type MobileDeviceInfo,
  type MobileGatewayBindMode,
  type MobileGatewayState,
} from '../../../shared/ipc/mobileGatewayService.js'
import { useService } from '../useService.js'
import {
  auditActionLabel,
  auditDeviceLabel,
  chooseDesktopOrigin,
  devicePlatformLabel,
  formatCountdown,
  formatFingerprint,
  formatTimestamp,
  pairUrlLabel,
} from './mobileDevicesModel.js'
import {
  useGatewayDevices,
  useGatewayStatus,
  useMobileGatewaySettings,
  usePairingSession,
  useQrCodeDataUrl,
  useRecentAudit,
  writeMobileGatewayBind,
  writeMobileGatewayEnabled,
} from './mobileDevicesHooks.js'
import styles from './MobileDevicesEditor.module.css'

const BIND_OPTIONS: readonly SelectOption<MobileGatewayBindMode>[] = [
  {
    value: 'loopback',
    label: localize('mobileDevices.bind.loopback', 'Loopback (recommended)'),
  },
  { value: 'lan', label: localize('mobileDevices.bind.lan', 'LAN address') },
]

function gatewayStateLabel(state: MobileGatewayState): string {
  switch (state) {
    case 'stopped':
      return localize('mobileDevices.gateway.state.stopped', 'Stopped')
    case 'starting':
      return localize('mobileDevices.gateway.state.starting', 'Starting…')
    case 'running':
      return localize('mobileDevices.gateway.state.running', 'Running')
    case 'error':
      return localize('mobileDevices.gateway.state.error', 'Error')
  }
}

function capabilityLabel(available: boolean): string {
  return available
    ? localize('mobileDevices.gateway.capability.available', 'Available')
    : localize('mobileDevices.gateway.capability.unavailable', 'Unavailable')
}

export function MobileDevicesEditor() {
  const gateway = useService(IMobileGatewayService)
  const configuration = useService(IConfigurationService)
  const dialog = useService(IDialogService)
  const commands = useService(ICommandService)
  const opener = useService(IOpenerService)

  const settings = useMobileGatewaySettings(configuration)
  const status = useGatewayStatus(gateway)
  const devices = useGatewayDevices(gateway)
  const pairing = usePairingSession(gateway, devices)

  const [auditOpen, setAuditOpen] = useState(false)
  const [deviceError, setDeviceError] = useState<string | undefined>(undefined)
  const audit = useRecentAudit(gateway, auditOpen)

  const canPair = status?.state === 'running'
  const qr = useQrCodeDataUrl(pairing.phase === 'active' ? pairing.selectedUrl : undefined)

  const browserOrigin =
    status?.state === 'running' ? chooseDesktopOrigin(status.origins) : undefined
  const selectedPairUrl = pairing.selectedUrl

  const openSettingsJson = useCallback(() => {
    void commands.executeCommand('workbench.action.openSettingsJson')
  }, [commands])

  const openExternal = useCallback(
    (url: string) => {
      void opener.open(url, { fromUserGesture: true })
    },
    [opener],
  )

  const revoke = useCallback(
    async (device: MobileDeviceInfo) => {
      setDeviceError(undefined)
      const name = device.name !== '' ? device.name : device.deviceId
      const { confirmed } = await dialog.confirm({
        message: localize('mobileDevices.devices.revokeConfirm', 'Revoke device "{name}"?', {
          name,
        }),
        detail: localize(
          'mobileDevices.devices.revokeDetail',
          'It will be disconnected immediately and must pair again.',
        ),
        primaryButton: localize('mobileDevices.devices.revoke', 'Revoke'),
        type: 'warning',
      })
      if (!confirmed) return
      try {
        await gateway.revokeDevice(device.deviceId)
      } catch (err) {
        setDeviceError(
          localize('mobileDevices.devices.revokeFailed', 'Could not revoke the device: {error}', {
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
    },
    [dialog, gateway],
  )

  return (
    <div className={styles['root']}>
      <div className={styles['page']}>
        <header className={styles['header']}>
          <h1 className={styles['title']}>{localize('mobileDevices.title', 'Mobile Devices')}</h1>
          <p className={styles['subtitle']}>
            {localize(
              'mobileDevices.subtitle',
              'Use your phone as a remote control for agent sessions running on this computer. The gateway serves the phone app and accepts paired devices; sessions and agent processes stay on this PC.',
            )}
          </p>
        </header>

        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <h2 className={styles['sectionTitle']}>
              {localize('mobileDevices.gateway.section', 'Gateway')}
            </h2>
            {status !== undefined && (
              <Badge
                tone={status.state === 'running' ? 'accent' : 'default'}
                className={status.state === 'error' ? styles['errorBadge'] : undefined}
              >
                <span data-testid="mobile-gateway-state">{gatewayStateLabel(status.state)}</span>
              </Badge>
            )}
          </div>
          <div className={styles['sectionBody']}>
            <div className={styles['settingRow']}>
              <div className={styles['settingText']}>
                <div className={styles['label']}>
                  {localize('mobileDevices.gateway.enable', 'Enable phone gateway')}
                </div>
                <div className={styles['description']}>
                  {localize(
                    'mobileDevices.gateway.enableDescription',
                    'Listens for paired phones and serves the phone web app. Off by default.',
                  )}
                </div>
              </div>
              <Toggle
                checked={settings.enabled}
                onChange={(checked) => writeMobileGatewayEnabled(configuration, checked)}
                data-testid="mobile-gateway-enabled"
                aria-label={localize('mobileDevices.gateway.enable', 'Enable phone gateway')}
              />
            </div>

            {status === undefined ? (
              <div className={styles['loading']}>
                <Spinner size={14} />
                <span>{localize('mobileDevices.gateway.loading', 'Loading status…')}</span>
              </div>
            ) : (
              <>
                <div className={styles['statusRow']}>
                  {status.state === 'running' && status.listenAddress !== undefined && (
                    <span className={styles['statusMeta']}>
                      {localize('mobileDevices.gateway.listenAddress', 'Listening on')}{' '}
                      <code className={styles['inlineCode']} data-testid="mobile-gateway-listen">
                        {status.listenAddress}
                      </code>
                    </span>
                  )}
                  {status.state === 'running' && (
                    <span className={styles['statusMeta']} data-testid="mobile-gateway-connected">
                      {localize('mobileDevices.gateway.connectedDevices', '{count} connected', {
                        count: status.connectedDeviceCount,
                      })}
                    </span>
                  )}
                </div>

                {status.state === 'running' && browserOrigin !== undefined && (
                  <div className={styles['actionRow']}>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openExternal(browserOrigin)}
                      data-testid="mobile-gateway-open-browser"
                    >
                      <ExternalLink size={14} strokeWidth={1.75} className={styles['buttonIcon']} />
                      {localize(
                        'mobileDevices.gateway.openInBrowser',
                        'Open phone app in your PC browser',
                      )}
                    </Button>
                    <span className={styles['hint']}>
                      {localize(
                        'mobileDevices.gateway.openInBrowserHint',
                        'Opens the phone web app in your default browser. If nothing opens (for example under WSL), open the address above manually.',
                      )}
                    </span>
                  </div>
                )}

                {status.state === 'error' && status.error !== undefined && (
                  <div className={styles['errorText']} data-testid="mobile-gateway-error">
                    {status.error}
                  </div>
                )}

                {status.insecure && (
                  <div className={styles['warning']} data-testid="mobile-gateway-insecure">
                    <TriangleAlert size={14} strokeWidth={1.75} />
                    <span>
                      {localize(
                        'mobileDevices.gateway.insecure',
                        'Clear-text HTTP is bound to a non-loopback address. Anyone on the network can read device credentials. Development only.',
                      )}
                    </span>
                  </div>
                )}

                {status.certificate !== undefined && (
                  <div className={styles['certificate']} data-testid="mobile-gateway-certificate">
                    <span className={styles['fieldLabel']}>
                      {localize('mobileDevices.gateway.certificate', 'Certificate fingerprint')}
                    </span>
                    <code className={styles['inlineCode']}>
                      {formatFingerprint(status.certificate.fingerprint)}
                    </code>
                    <span className={styles['statusMeta']}>
                      {localize('mobileDevices.gateway.certificateExpires', 'Expires {date}', {
                        date: formatTimestamp(status.certificate.expiresAt),
                      })}
                    </span>
                    <span className={styles['description']}>
                      {localize(
                        'mobileDevices.gateway.certificateHint',
                        'Compare this with the fingerprint shown on the phone pairing page before you pair.',
                      )}
                    </span>
                  </div>
                )}

                {status.state === 'running' && (
                  <div className={styles['capabilities']}>
                    <span className={styles['fieldLabel']}>
                      {localize('mobileDevices.gateway.capabilities', 'Capabilities')}
                    </span>
                    <div className={styles['capabilityRow']}>
                      <span>
                        {localize('mobileDevices.gateway.capability.installable', 'Installable')}
                      </span>
                      <Badge tone={status.capabilities.installable ? 'accent' : 'default'}>
                        {capabilityLabel(status.capabilities.installable)}
                      </Badge>
                    </div>
                    <div className={styles['capabilityRow']}>
                      <span>
                        {localize('mobileDevices.gateway.capability.push', 'Push notifications')}
                      </span>
                      <Badge tone={status.capabilities.push ? 'accent' : 'default'}>
                        {capabilityLabel(status.capabilities.push)}
                      </Badge>
                    </div>
                    <p className={styles['description']} data-testid="mobile-gateway-push-hint">
                      {status.capabilities.push
                        ? localize(
                            'mobileDevices.gateway.pushRelayHint',
                            'Delivered through Apple / Google push servers; this computer must be able to reach the public internet.',
                          )
                        : localize(
                            'mobileDevices.gateway.pushRequiresHttps',
                            'Push requires an HTTPS address. Add the Tailscale host name to mobileGateway.allowedHosts.',
                          )}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <h2 className={styles['sectionTitle']}>
              {localize('mobileDevices.bind.section', 'Listen mode')}
            </h2>
          </div>
          <div className={styles['sectionBody']}>
            <div className={styles['settingRow']}>
              <div className={styles['settingText']}>
                <div className={styles['label']}>
                  {localize('mobileDevices.bind.label', 'Where the gateway listens')}
                </div>
                <div className={styles['description']}>
                  {localize(
                    'mobileDevices.bind.portDescription',
                    'Port {port} is used for pairing, the phone app and the WebSocket.',
                    { port: settings.port },
                  )}
                </div>
              </div>
              <Select
                value={settings.bind}
                options={BIND_OPTIONS}
                onChange={(bind) => writeMobileGatewayBind(configuration, bind)}
                data-testid="mobile-gateway-bind"
                aria-label={localize('mobileDevices.bind.label', 'Where the gateway listens')}
              />
            </div>

            {settings.bind === 'loopback' ? (
              <div className={styles['bindDetails']}>
                <p className={styles['description']}>
                  {localize(
                    'mobileDevices.bind.loopbackDescription',
                    'Listens on 127.0.0.1 only. Expose it over HTTPS with Tailscale Serve:',
                  )}
                </p>
                <code className={styles['command']}>tailscale serve --bg {settings.port}</code>
                <p className={styles['description']}>
                  {localize(
                    'mobileDevices.bind.tailscaleHint',
                    'Add the Tailscale host name (for example pc.tailnet-name.ts.net) to mobileGateway.allowedHosts so pairing links use HTTPS and the phone app can be installed.',
                  )}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={openSettingsJson}
                  data-testid="mobile-gateway-open-settings-json"
                >
                  <FileJson size={14} strokeWidth={1.75} className={styles['buttonIcon']} />
                  {localize(
                    'mobileDevices.bind.editAllowedHosts',
                    'Edit allowedHosts in settings.json',
                  )}
                </Button>
              </div>
            ) : (
              <div className={styles['bindDetails']}>
                <p className={styles['description']}>
                  {localize(
                    'mobileDevices.bind.lanDescription',
                    'Binds a LAN address and serves HTTPS with a certificate generated on this PC. The phone must confirm the certificate fingerprint shown on the pairing page; installing the app and Web Push stay unavailable until the certificate is trusted.',
                  )}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className={styles['section']}>
          <div className={styles['sectionHeader']}>
            <h2 className={styles['sectionTitle']}>
              {localize('mobileDevices.pairing.section', 'Pair a device')}
            </h2>
          </div>
          <div className={styles['sectionBody']}>
            {pairing.phase === 'idle' && (
              <div className={styles['pairingIdle']}>
                <Button
                  variant="primary"
                  onClick={() => void pairing.start()}
                  disabled={!canPair}
                  data-testid="mobile-pairing-start"
                >
                  <Smartphone size={14} strokeWidth={1.75} className={styles['buttonIcon']} />
                  {localize('mobileDevices.pairing.pair', 'Pair new device')}
                </Button>
                {!canPair && (
                  <p className={styles['hint']}>
                    {localize(
                      'mobileDevices.pairing.requiresRunning',
                      'Turn on the gateway before pairing a device.',
                    )}
                  </p>
                )}
                {pairing.error !== undefined && (
                  <p className={styles['errorText']}>
                    {localize('mobileDevices.pairing.error', 'Could not start pairing: {error}', {
                      error: pairing.error,
                    })}
                  </p>
                )}
              </div>
            )}

            {pairing.phase === 'starting' && (
              <Button variant="primary" busy data-testid="mobile-pairing-starting">
                {localize('mobileDevices.pairing.starting', 'Starting pairing…')}
              </Button>
            )}

            {pairing.phase === 'active' && pairing.session !== undefined && (
              <div className={styles['pairingLayout']} data-testid="mobile-pairing-active">
                <div className={styles['qrBox']}>
                  {qr.dataUrl !== undefined ? (
                    <img
                      className={styles['qrImage']}
                      src={qr.dataUrl}
                      alt={localize('mobileDevices.pairing.qrAlt', 'Pairing QR code')}
                      data-testid="mobile-pairing-qr"
                    />
                  ) : qr.error !== undefined ? (
                    <div className={styles['qrError']}>{qr.error}</div>
                  ) : (
                    <Spinner size={24} />
                  )}
                </div>
                <div className={styles['pairingInfo']}>
                  <div className={styles['fieldLabel']}>
                    {localize('mobileDevices.pairing.code', 'Pairing code')}
                  </div>
                  <div className={styles['pairCode']} data-testid="mobile-pairing-code">
                    {formatPairCode(pairing.session.code)}
                  </div>
                  <div className={styles['countdown']} data-testid="mobile-pairing-countdown">
                    {pairing.fixedExpiry
                      ? localize(
                          'mobileDevices.pairing.fixedExpiry',
                          'This code does not expire (test mode).',
                        )
                      : localize('mobileDevices.pairing.expires', 'Code expires in {time}', {
                          time: formatCountdown(pairing.remainingMs),
                        })}
                  </div>

                  {pairing.pairUrls.length === 0 ? (
                    <div className={styles['warning']}>
                      <TriangleAlert size={14} strokeWidth={1.75} />
                      <span>
                        {localize(
                          'mobileDevices.pairing.noOrigins',
                          'No address is available. Add a Tailscale host name to mobileGateway.allowedHosts.',
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className={styles['originSection']}>
                      <div className={styles['fieldLabel']}>
                        {localize('mobileDevices.pairing.origin', 'Address')}
                      </div>
                      {pairing.pairUrls.length === 1 ? (
                        <code className={styles['inlineCode']}>
                          {pairUrlLabel(pairing.pairUrls[0]!)}
                        </code>
                      ) : (
                        <div
                          className={styles['originButtons']}
                          role="group"
                          aria-label={localize('mobileDevices.pairing.origin', 'Address')}
                        >
                          {pairing.pairUrls.map((url, index) => (
                            <button
                              key={url}
                              type="button"
                              className={cx(
                                styles['originButton'],
                                index === pairing.selectedUrlIndex && styles['originButtonActive'],
                              )}
                              aria-pressed={index === pairing.selectedUrlIndex}
                              onClick={() => pairing.selectUrl(index)}
                            >
                              {pairUrlLabel(url)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <p className={styles['description']}>
                    {localize(
                      'mobileDevices.pairing.scan',
                      'Scan the QR code with your phone camera, or open the link on your phone.',
                    )}
                  </p>

                  <div className={styles['actionRow']}>
                    {selectedPairUrl !== undefined && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openExternal(selectedPairUrl)}
                        data-testid="mobile-pairing-open-browser"
                      >
                        <ExternalLink
                          size={14}
                          strokeWidth={1.75}
                          className={styles['buttonIcon']}
                        />
                        {localize(
                          'mobileDevices.pairing.openInBrowser',
                          'Open pairing page in your PC browser',
                        )}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void pairing.cancel()}
                      data-testid="mobile-pairing-cancel"
                    >
                      {localize('mobileDevices.pairing.cancel', 'Cancel')}
                    </Button>
                  </div>

                  {selectedPairUrl !== undefined && (
                    <p className={styles['hint']}>
                      {localize(
                        'mobileDevices.pairing.openInBrowserHint',
                        'Opens the selected address with the pairing code filled in. Confirm with Start pairing on the page.',
                      )}
                    </p>
                  )}
                </div>
              </div>
            )}

            {pairing.phase === 'expired' && (
              <div className={styles['pairingNotice']} data-testid="mobile-pairing-expired">
                <p>{localize('mobileDevices.pairing.expired', 'This pairing code has expired.')}</p>
                <Button
                  variant="primary"
                  onClick={() => void pairing.start()}
                  data-testid="mobile-pairing-regenerate"
                >
                  {localize('mobileDevices.pairing.regenerate', 'Generate a new code')}
                </Button>
              </div>
            )}

            {pairing.phase === 'succeeded' && (
              <div className={styles['pairingNotice']} data-testid="mobile-pairing-success">
                <p>{localize('mobileDevices.pairing.succeeded', 'Device paired successfully.')}</p>
                <Button
                  variant="secondary"
                  onClick={() => void pairing.start()}
                  data-testid="mobile-pairing-another"
                >
                  {localize('mobileDevices.pairing.pairAnother', 'Pair another device')}
                </Button>
              </div>
            )}
          </div>
        </section>

        <section className={styles['section']} data-testid="mobile-devices-section">
          <div className={styles['sectionHeader']}>
            <h2 className={styles['sectionTitle']}>
              {localize('mobileDevices.devices.section', 'Paired devices')}
            </h2>
          </div>
          <div className={styles['sectionBody']}>
            {devices === undefined ? (
              <Spinner size={16} />
            ) : devices.length === 0 ? (
              <div className={styles['empty']}>
                <p>{localize('mobileDevices.devices.empty', 'No paired devices yet.')}</p>
                <p className={styles['hint']}>
                  {localize(
                    'mobileDevices.devices.emptyHint',
                    'Pair a phone above to see it here.',
                  )}
                </p>
              </div>
            ) : (
              <ul className={styles['deviceList']}>
                {devices.map((device) => (
                  <li
                    key={device.deviceId}
                    className={styles['deviceRow']}
                    data-testid={`mobile-device-${device.deviceId}`}
                  >
                    <span
                      className={cx(
                        styles['statusDot'],
                        device.connected ? styles['statusDotOnline'] : styles['statusDotOffline'],
                      )}
                      aria-hidden="true"
                    />
                    <div className={styles['deviceMain']}>
                      <div className={styles['deviceName']}>
                        {device.name !== '' ? device.name : device.deviceId}
                      </div>
                      <div className={styles['deviceMeta']}>
                        <Badge>{devicePlatformLabel(device.platform)}</Badge>
                        <span>
                          {localize('mobileDevices.devices.pairedAt', 'Paired {time}', {
                            time: formatTimestamp(device.createdAt),
                          })}
                        </span>
                        <span>
                          {localize('mobileDevices.devices.lastSeen', 'Last seen {time}', {
                            time: formatTimestamp(device.lastSeenAt),
                          })}
                        </span>
                        <span data-testid={`mobile-device-notifications-${device.deviceId}`}>
                          {device.notificationsEnabled
                            ? localize('mobileDevices.devices.notificationsOn', 'Notifications: on')
                            : localize(
                                'mobileDevices.devices.notificationsOff',
                                'Notifications: off',
                              )}
                        </span>
                      </div>
                    </div>
                    <span className={styles['deviceOnline']}>
                      {device.connected
                        ? localize('mobileDevices.devices.online', 'Online')
                        : localize('mobileDevices.devices.offline', 'Offline')}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void revoke(device)}
                      data-testid={`mobile-device-revoke-${device.deviceId}`}
                    >
                      {localize('mobileDevices.devices.revoke', 'Revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {deviceError !== undefined && <div className={styles['errorText']}>{deviceError}</div>}
          </div>
        </section>

        <section className={styles['section']}>
          <button
            type="button"
            className={styles['sectionHeaderButton']}
            aria-expanded={auditOpen}
            onClick={() => setAuditOpen((open) => !open)}
            data-testid="mobile-audit-toggle"
          >
            {auditOpen ? (
              <ChevronDown size={16} strokeWidth={1.75} className={styles['sectionChevron']} />
            ) : (
              <ChevronRight size={16} strokeWidth={1.75} className={styles['sectionChevron']} />
            )}
            <span className={styles['sectionTitle']}>
              {localize('mobileDevices.audit.section', 'Recent activity')}
            </span>
          </button>
          {auditOpen && (
            <div className={styles['sectionBody']}>
              {audit === undefined ? (
                <Spinner size={16} />
              ) : audit.length === 0 ? (
                <div className={styles['empty']}>
                  {localize('mobileDevices.audit.empty', 'No activity recorded yet.')}
                </div>
              ) : (
                <table className={styles['auditTable']}>
                  <thead>
                    <tr>
                      <th>{localize('mobileDevices.audit.time', 'Time')}</th>
                      <th>{localize('mobileDevices.audit.device', 'Device')}</th>
                      <th>{localize('mobileDevices.audit.action', 'Action')}</th>
                      <th>{localize('mobileDevices.audit.result', 'Result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry, index) => (
                      <tr key={`${entry.ts}-${index}`} data-testid="mobile-audit-row">
                        <td className={styles['auditTime']}>{formatTimestamp(entry.ts)}</td>
                        <td>{auditDeviceLabel(entry)}</td>
                        <td>{auditActionLabel(entry.action)}</td>
                        <td>
                          <Badge
                            tone={entry.result === 'success' ? 'accent' : 'default'}
                            className={
                              entry.result === 'failure' ? styles['failureBadge'] : undefined
                            }
                          >
                            {entry.result === 'success'
                              ? localize('mobileDevices.audit.success', 'Success')
                              : localize('mobileDevices.audit.failure', 'Failure')}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
