/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-singleton owner of the phone gateway. Resolves `mobileGateway.*`
 *  from settings.json at startup (main has no IConfigurationService; update and
 *  AI read the file directly too) and accepts `applyConfig` from the renderer
 *  for live changes. Owns the HTTP/WS server lifecycle through the
 *  stopped/starting/running/error state machine.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Disposable,
  Emitter,
  type Event,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import {
  buildPairUrl,
  formatPairCode,
  isValidPairCodeShape,
  normalizePairCode,
} from '@universe-editor/mobile-protocol'
import type {
  IMobileBridgeService,
  IMobileGatewayService,
  MobileAuditEntry,
  MobileDeviceInfo,
  MobileGatewayBindMode,
  MobileGatewayConfig,
  MobileGatewayStatus,
  MobileGatewayState,
  MobilePairingSession,
} from '../../../shared/ipc/mobileGatewayService.js'
import { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import type { ConfigLocationMainService } from '../configLocation/configLocationMainService.js'
import { getAppVersion } from '../../appVersion.js'
import { resolveFromRepo } from '../../repoPaths.js'
import { AuditLog, type AuditInput } from './auditLog.js'
import { DeviceStore } from './deviceStore.js'
import {
  buildOrigins,
  capabilitiesForOrigins,
  DEFAULT_MOBILE_GATEWAY_CONFIG,
  gatewayEnvironmentFromProcess,
  isMobileGatewayEnabled,
  parseMobileGatewayConfig,
  readMobileGatewayConfig,
  resolveGatewayRuntime,
} from './gatewayConfig.js'
import { buildAllowedHosts } from './requestSecurity.js'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MobileGatewayServer,
} from './mobileGatewayServer.js'
import { MobileGatewayHub } from './mobileGatewayHub.js'
import { PairingService } from './pairingService.js'

const MAX_AUDIT_LIMIT = 200

export class MobileGatewayMainService extends Disposable implements IMobileGatewayService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _deviceStore: DeviceStore
  private readonly _pairing: PairingService
  private readonly _audit: AuditLog
  private readonly _assetsDir: string
  private readonly _onDidChangeStatus = this._register(new Emitter<MobileGatewayStatus>())
  readonly onDidChangeStatus: Event<MobileGatewayStatus> = this._onDidChangeStatus.event
  private readonly _onDidChangeDevices = this._register(new Emitter<readonly MobileDeviceInfo[]>())
  readonly onDidChangeDevices: Event<readonly MobileDeviceInfo[]> = this._onDidChangeDevices.event

  private readonly _windowBridges = new Map<number, IMobileBridgeService>()
  private readonly _hub: MobileGatewayHub

  private _config: MobileGatewayConfig = DEFAULT_MOBILE_GATEWAY_CONFIG
  private _state: MobileGatewayState = 'stopped'
  private _error: string | undefined
  private _bind: MobileGatewayBindMode = 'loopback'
  private _insecure = false
  private _listenAddress: string | undefined
  private _origins: readonly string[] = []
  private _server: MobileGatewayServer | undefined
  private _runningKey: string | undefined
  private _serial: Promise<void> = Promise.resolve()
  private _disposed = false

  constructor(
    @IConfigLocationService private readonly _configLocation: ConfigLocationMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'mobileGateway',
      name: 'Mobile Gateway',
    })
    this._hub = new MobileGatewayHub(this._logger)

    const mobileDir = join(app.getPath('userData'), 'mobile')
    this._deviceStore = new DeviceStore(join(mobileDir, 'devices.json'), {
      onCorrupt: (error) => this._logger.warn(`devices.json is unreadable: ${error.message}`),
      onChmodError: (error) =>
        this._logger.warn(`devices.json chmod 0600 failed: ${error.message}`),
    })
    this._audit = new AuditLog(join(mobileDir, 'audit.jsonl'))
    const fixedCode = resolveE2ePairCode(this._logger)
    this._pairing = new PairingService(fixedCode === undefined ? {} : { fixedCode })
    this._assetsDir = resolveMobileAssetsDir()

    this._register(this._configLocation.onDidChangeConfigDir(() => void this._reloadFromDisk()))
    void this._reloadFromDisk()
  }

  getStatus(): Promise<MobileGatewayStatus> {
    return Promise.resolve(this._status())
  }

  startPairing(): Promise<MobilePairingSession> {
    const session = this._pairing.start()
    const code = formatPairCode(session.code)
    this._recordAudit({ action: 'pairing_started', result: 'success' })
    return Promise.resolve({
      code,
      expiresAt: session.expiresAt,
      pairUrls: this._origins.map((origin) => buildPairUrl(origin, session.code)),
    })
  }

  cancelPairing(): Promise<void> {
    this._pairing.cancel()
    this._recordAudit({ action: 'pairing_cancelled', result: 'success' })
    return Promise.resolve()
  }

  async listDevices(): Promise<readonly MobileDeviceInfo[]> {
    const devices = await this._deviceStore.list()
    const connected = this._server?.getConnectedDeviceIds() ?? new Set<string>()
    return devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      connected: connected.has(device.deviceId),
    }))
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const removed = await this._deviceStore.revoke(deviceId)
    this._server?.revokeConnections(deviceId)
    await this._audit.append({
      ...(removed ? { deviceId } : {}),
      action: 'device_revoked',
      result: removed ? 'success' : 'failure',
      ...(removed ? {} : { detail: 'device not found' }),
    })
    this._logger.info(`revoke device id=${deviceId} removed=${removed}`)
    await this._emitDevices()
  }

  getRecentAudit(limit: number): Promise<readonly MobileAuditEntry[]> {
    const bounded = Number.isFinite(limit)
      ? Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit)))
      : 50
    return this._audit.recent(bounded)
  }

  applyConfig(config: MobileGatewayConfig): Promise<void> {
    if (this._disposed) return Promise.resolve()
    return this._enqueue(() => this._applyConfig(config))
  }

  registerWindowBridge(
    windowId: number,
    bridge: IMobileBridgeService,
    workspaceName: () => string = () => '',
  ): void {
    this._windowBridges.set(windowId, bridge)
    this._hub.registerWindow(windowId, bridge, workspaceName)
  }

  unregisterWindowBridge(windowId: number): void {
    this._windowBridges.delete(windowId)
    this._hub.unregisterWindow(windowId)
  }

  /** M2 uses this to fan the inbox projection out to every window. */
  getWindowBridges(): ReadonlyMap<number, IMobileBridgeService> {
    return this._windowBridges
  }

  override dispose(): void {
    this._disposed = true
    this._pairing.cancel()
    this._hub.dispose()
    const server = this._server
    this._server = undefined
    if (server !== undefined) void server.stop()
    super.dispose()
  }

  private _enqueue(task: () => Promise<void>): Promise<void> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _reloadFromDisk(): Promise<void> {
    try {
      const config = await readMobileGatewayConfig(this._configLocation.currentDir)
      await this.applyConfig(config)
    } catch (err) {
      this._logger.warn(`failed to read mobile gateway settings: ${String(err)}`)
    }
  }

  private async _applyConfig(config: MobileGatewayConfig): Promise<void> {
    this._config = normalizeConfig(config)
    this._bind = this._config.bind

    const env = gatewayEnvironmentFromProcess()
    if (!isMobileGatewayEnabled(this._config, env)) {
      await this._teardown()
      this._setState('stopped')
      return
    }

    const runtime = resolveGatewayRuntime({
      config: this._config,
      env,
      isPackaged: app.isPackaged,
      interfaces: networkInterfaces(),
    })
    if (!runtime.ok) {
      await this._teardown()
      this._logger.warn(`mobile gateway unavailable: ${runtime.error}`)
      this._setError(runtime.error)
      this._recordAudit({ action: 'gateway_error', result: 'failure', detail: runtime.error })
      return
    }

    this._bind = runtime.bind
    this._insecure = runtime.insecure
    const allowedHosts = buildAllowedHosts({
      bindHost: runtime.host,
      port: runtime.port,
      extraHosts: this._config.allowedHosts,
    })
    const runningKey = JSON.stringify({
      host: runtime.host,
      port: runtime.port,
      allowedHosts,
      assetsDir: this._assetsDir,
    })
    if (this._state === 'running' && runningKey === this._runningKey) return

    await this._teardown()
    this._setState('starting')
    const server = new MobileGatewayServer({
      host: runtime.host,
      port: runtime.port,
      allowedHosts,
      assetsDir: this._assetsDir,
      store: this._deviceStore,
      pairing: this._pairing,
      audit: this._audit,
      logger: this._logger,
      serverVersion: getAppVersion(),
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      onConnectionsChanged: () => this._handleConnectionsChanged(),
      hub: this._hub,
    })
    try {
      const { port } = await server.start()
      if (this._disposed) {
        await server.stop()
        return
      }
      this._server = server
      this._listenAddress = `${runtime.host}:${port}`
      this._origins = buildOrigins({
        bind: runtime.bind,
        host: runtime.host,
        port,
        allowedHosts: this._config.allowedHosts,
      })
      this._runningKey = runningKey
      this._state = 'running'
      this._error = undefined
      this._emitStatus()
      this._logger.info(
        `started bind=${runtime.bind} address=${this._listenAddress} insecure=${runtime.insecure}`,
      )
      this._recordAudit({
        action: 'gateway_start',
        result: 'success',
        detail: `${runtime.bind} ${this._listenAddress}`,
      })
    } catch (err) {
      const message = describeListenError(err, runtime.host, runtime.port)
      this._logger.error(`mobile gateway failed to listen: ${message}`)
      this._server = undefined
      this._listenAddress = undefined
      this._origins = []
      this._setError(message)
      this._recordAudit({ action: 'gateway_error', result: 'failure', detail: message })
    }
  }

  private async _teardown(): Promise<void> {
    const server = this._server
    this._server = undefined
    this._runningKey = undefined
    this._listenAddress = undefined
    this._origins = []
    this._insecure = false
    if (server === undefined) return
    await server.stop()
    this._logger.info('stopped')
    this._recordAudit({ action: 'gateway_stop', result: 'success' })
  }

  private _setState(state: MobileGatewayState): void {
    this._state = state
    this._error = undefined
    this._emitStatus()
  }

  private _setError(error: string): void {
    this._state = 'error'
    this._error = error
    this._emitStatus()
  }

  private _emitStatus(): void {
    this._onDidChangeStatus.fire(this._status())
  }

  private _status(): MobileGatewayStatus {
    return {
      state: this._state,
      ...(this._error !== undefined ? { error: this._error } : {}),
      ...(this._listenAddress !== undefined ? { listenAddress: this._listenAddress } : {}),
      origins: this._origins,
      insecure: this._insecure,
      bind: this._bind,
      capabilities: capabilitiesForOrigins(this._origins),
      connectedDeviceCount: this._server?.getConnectedDeviceCount() ?? 0,
    }
  }

  private async _emitDevices(): Promise<void> {
    try {
      this._onDidChangeDevices.fire(await this.listDevices())
    } catch (err) {
      this._logger.warn(`failed to list devices: ${String(err)}`)
    }
  }

  /** Fire-and-forget audit write; a failed write must never become an unhandled rejection. */
  private _recordAudit(input: AuditInput): void {
    void this._audit.append(input).catch((err) => {
      this._logger.warn(`audit append failed: ${String(err)}`)
    })
  }

  /** Connection churn changes both the device rows (online flag) and the count in status. */
  private _handleConnectionsChanged(): void {
    this._emitStatus()
    void this._emitDevices()
  }
}

function normalizeConfig(config: MobileGatewayConfig): MobileGatewayConfig {
  const parsed = parseMobileGatewayConfig({
    'mobileGateway.enabled': config.enabled,
    'mobileGateway.bind': config.bind,
    'mobileGateway.lanAddress': config.lanAddress,
    'mobileGateway.port': config.port,
    'mobileGateway.allowedHosts': config.allowedHosts,
  })
  // A renderer omission must not silently enable the gateway.
  return parsed
}

function resolveE2ePairCode(logger: ILogger): string | undefined {
  if (app.isPackaged) return undefined
  const raw = process.env['UNIVERSE_MOBILE_E2E_CODE']?.trim()
  if (raw === undefined || raw === '') return undefined
  const normalized = normalizePairCode(raw)
  if (!isValidPairCodeShape(normalized)) {
    logger.warn('UNIVERSE_MOBILE_E2E_CODE is not a valid pairing code; ignoring')
    return undefined
  }
  return normalized
}

function resolveMobileAssetsDir(): string {
  const override = process.env['UNIVERSE_MOBILE_ASSETS_DIR']?.trim()
  if (override !== undefined && override !== '') return resolve(override)
  if (app.isPackaged) return join(process.resourcesPath, 'mobile')
  return resolveFromRepo('apps/mobile/dist')
}

function describeListenError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用`
  if (code === 'EACCES') return `没有权限监听 ${host}:${port}`
  if (code === 'EADDRNOTAVAIL') return `无法绑定地址 ${host}`
  const message = err instanceof Error ? err.message : String(err)
  return `无法启动手机网关：${message}`
}
