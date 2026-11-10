/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-singleton owner of the phone gateway. Persists `gateway.json` in
 *  the machine-local `<userData>/mobile` directory (never the shared config
 *  directory) and owns the HTTP/WS server lifecycle through the
 *  stopped/starting/running/error state machine.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, app } from 'electron'
import { hostname, networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Disposable,
  Emitter,
  URI,
  type Event,
  type ILogger,
  type IOpenWindowInfo,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import {
  buildPairUrl,
  formatPairCode,
  isValidPairCodeShape,
  MOBILE_CERT_PATH,
  normalizePairCode,
} from '@universe-editor/mobile-protocol'
import type {
  IMobileBridgeService,
  IMobileGatewayService,
  MobileAuditEntry,
  MobileDeviceInfo,
  MobileGatewayBindMode,
  MobileGatewayConfig,
  MobileGatewayConfigPatch,
  MobileGatewayConfigState,
  MobileGatewayConfigUpdateResult,
  MobileGatewayStatus,
  MobileGatewayState,
  MobileGatewayTlsTrustWarning,
  MobilePairingSession,
} from '../../../shared/ipc/mobileGatewayService.js'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../shared/ipc/mobileGatewayService.js'
import { IRecentWorkspacesService } from '../workspace/recentWorkspacesMainService.js'
import type { RecentWorkspacesMainService } from '../workspace/recentWorkspacesMainService.js'
import { getAppVersion } from '../../appVersion.js'
import { resolveFromRepo } from '../../repoPaths.js'
import { AuditLog, type AuditInput } from './auditLog.js'
import { DeviceStore } from './deviceStore.js'
import {
  buildOrigins,
  capabilitiesForOrigins,
  gatewayEnvironmentFromProcess,
  isMobileGatewayEnabled,
  listLanAddresses,
  resolveGatewayRuntime,
  type GatewayOrigins,
} from './gatewayConfig.js'
import { MOBILE_GATEWAY_CONFIG_FILE } from './gatewayConfigFile.js'
import { MobileGatewayConfigStore } from './gatewayConfigStore.js'
import { createWorkspaceGitDirtyProbe } from './workspaceGitDirtyProbe.js'
import { WorkspaceGitStatusService } from './workspaceGitStatus.js'
import { WorkspaceSessionHistoryReader } from './workspaceSessionHistoryReader.js'
import { ensureLanCertificate, type LanCertificate } from './lanCertificate.js'
import { buildAllowedHosts } from './requestSecurity.js'
import { isCertificateRejection, isLocalTlsClient } from './tlsTrust.js'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MobileGatewayServer,
  type MobileGatewayDiagnosticEvent,
} from './mobileGatewayServer.js'
import {
  MobileGatewayHub,
  isSameWorkspace,
  type MobileGatewayAttention,
} from './mobileGatewayHub.js'
import { MobileAttachmentStore } from './mobileAttachmentStore.js'
import { MobileNotificationRouter } from './mobileNotificationRouter.js'
import { PairingService } from './pairingService.js'
import { loadOrCreateVapidKeys, type VapidKeyPair } from './vapidKeys.js'
import { createWebPushSender, type WebPushSender } from './webPushSender.js'

const MAX_AUDIT_LIMIT = 200

/** Subset of `WindowMainService` the gateway needs; set after windows are constructed. */
export interface MobileGatewayWindowProvider {
  getOpenWindowInfos(): readonly IOpenWindowInfo[]
  openWindowForFolder(folder?: URI): Promise<void>
}

const BRIDGE_WAIT_INTERVAL_MS = 100

export class MobileGatewayMainService extends Disposable implements IMobileGatewayService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _deviceStore: DeviceStore
  private readonly _pairing: PairingService
  private readonly _audit: AuditLog
  private readonly _assetsDir: string
  private readonly _mobileDir: string
  private readonly _attachments: MobileAttachmentStore
  private readonly _configFile: string
  private readonly _configStore: MobileGatewayConfigStore
  private readonly _onDidChangeStatus = this._register(new Emitter<MobileGatewayStatus>())
  readonly onDidChangeStatus: Event<MobileGatewayStatus> = this._onDidChangeStatus.event
  private readonly _onDidChangeDevices = this._register(new Emitter<readonly MobileDeviceInfo[]>())
  readonly onDidChangeDevices: Event<readonly MobileDeviceInfo[]> = this._onDidChangeDevices.event
  private readonly _onDidChangeConfig = this._register(new Emitter<MobileGatewayConfigState>())
  readonly onDidChangeConfig: Event<MobileGatewayConfigState> = this._onDidChangeConfig.event

  private readonly _windowBridges = new Map<number, IMobileBridgeService>()
  private readonly _gitStatus: WorkspaceGitStatusService
  private readonly _sessionHistoryReader: WorkspaceSessionHistoryReader
  private readonly _hub: MobileGatewayHub
  private _windows: MobileGatewayWindowProvider | undefined

  private _config: MobileGatewayConfig = DEFAULT_MOBILE_GATEWAY_CONFIG
  private _configState: MobileGatewayConfigState = {
    config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG },
  }
  private _ready: Promise<void>
  private _state: MobileGatewayState = 'stopped'
  private _error: string | undefined
  private _bind: MobileGatewayBindMode = 'loopback'
  private _insecure = false
  private _listenAddress: string | undefined
  private _origins: readonly string[] = []
  private _originsInfo: GatewayOrigins = { urls: [], trustedSecure: false }
  private _certificate: LanCertificate | undefined
  private _lanOrigin: string | undefined
  private _lanHostnameOrigin: string | undefined
  private _boundHost: string | undefined
  private _tlsTrustWarning: MobileGatewayTlsTrustWarning | undefined
  private _server: MobileGatewayServer | undefined
  private _router: MobileNotificationRouter | undefined
  private readonly _vapidPromise: Promise<VapidKeyPair | undefined>
  private readonly _pushSender: WebPushSender
  private _runningKey: string | undefined
  private _serial: Promise<void> = Promise.resolve()
  private _disposed = false

  constructor(
    @IRecentWorkspacesService private readonly _recent: RecentWorkspacesMainService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'mobileGateway',
      name: 'Mobile Gateway',
    })
    this._pushSender = createWebPushSender()
    const mobileDir = join(app.getPath('userData'), 'mobile')
    this._mobileDir = mobileDir
    this._attachments = new MobileAttachmentStore({
      rootDir: join(mobileDir, 'attachments'),
      logger: this._logger,
    })
    this._gitStatus = this._register(new WorkspaceGitStatusService({ logger: this._logger }))
    this._sessionHistoryReader = new WorkspaceSessionHistoryReader({
      userDataDir: app.getPath('userData'),
      logger: this._logger,
    })
    this._hub = new MobileGatewayHub(
      this._logger,
      {
        listOpenWorkspaces: () => this._openWorkspaces(),
        listRecentWorkspaces: async () =>
          (await this._recent.getRecent()).map((entry) => ({
            folder: entry.folder.toString(),
            name: entry.name,
            ...(entry.folder.authority ? { authority: entry.folder.authority } : {}),
          })),
        openWorkspace: (folder) =>
          this._windows?.openWindowForFolder(URI.parse(folder)) ?? Promise.resolve(),
        waitForBridge: (folder, authority, timeoutMs) =>
          this._waitForBridge(folder, authority, timeoutMs),
        workspaceGitDirty: createWorkspaceGitDirtyProbe({
          isDirty: (root, signal) => this._gitStatus.isDirty(root, signal),
        }),
        readWorkspaceSessionHistory: (workspace) => this._sessionHistoryReader.read(workspace),
        sessionHistoryWorkspaceLimit: () => this._config.sessionHistoryWorkspaceLimit,
        attachments: this._attachments,
      },
      (attention) => this._handleAttention(attention),
    )

    this._deviceStore = new DeviceStore(join(mobileDir, 'devices.json'), {
      onCorrupt: (error) => this._logger.warn(`devices.json is unreadable: ${error.message}`),
      onChmodError: (error) =>
        this._logger.warn(`devices.json chmod 0600 failed: ${error.message}`),
    })
    this._audit = new AuditLog(join(mobileDir, 'audit.jsonl'))
    this._vapidPromise = loadOrCreateVapidKeys(join(mobileDir, 'vapid.json'), {
      onCorrupt: (error) => this._logger.warn(`vapid.json is unreadable: ${error.message}`),
      onChmodError: (error) => this._logger.warn(`vapid.json chmod 0600 failed: ${error.message}`),
    }).catch((err) => {
      this._logger.warn(`Web Push is unavailable (VAPID setup failed): ${String(err)}`)
      return undefined
    })
    const fixedCode = resolveE2ePairCode(this._logger)
    this._pairing = new PairingService(fixedCode === undefined ? {} : { fixedCode })
    this._assetsDir = resolveMobileAssetsDir()

    this._configFile = join(mobileDir, MOBILE_GATEWAY_CONFIG_FILE)
    this._configStore = this._register(
      new MobileGatewayConfigStore({
        file: this._configFile,
        logger: this._logger,
        onChmodError: (error) =>
          this._logger.warn(`gateway.json chmod 0600 failed: ${error.message}`),
      }),
    )
    this._ready = this._enqueue(async () => {
      try {
        await this._attachments.initialize()
      } catch (err) {
        this._setError(`attachment storage is unavailable: ${String(err)}`)
        return
      }
      const state = await this._configStore.load()
      this._configState = state
      await this._applyConfig(state.config)
    })
    this._register(
      this._configStore.onDidChangeExternal((state) => {
        void this._enqueue(async () => {
          this._configState = state
          await this._applyConfig(state.config)
          this._onDidChangeConfig.fire(state)
        })
      }),
    )
    void this._refreshAttentionState()
  }

  async getStatus(): Promise<MobileGatewayStatus> {
    await this._ready.catch(() => undefined)
    return this._status()
  }

  startPairing(): Promise<MobilePairingSession> {
    const session = this._pairing.start()
    const code = formatPairCode(session.code)
    this._recordAudit({ action: 'pairing_started', result: 'success' })
    return Promise.resolve({
      code,
      expiresAt: session.expiresAt,
      pairUrls: this._origins.map((origin) =>
        buildPairUrl(
          origin,
          session.code,
          // Both LAN origins share the gateway certificate; the fingerprint
          // lets the phone check it before pairing.
          origin === this._lanOrigin || origin === this._lanHostnameOrigin
            ? this._certificate?.fingerprint
            : undefined,
        ),
      ),
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
      trusted: device.trusted === true,
      notificationsEnabled: device.notifications?.enabled === true,
    }))
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const removed = await this._deviceStore.revoke(deviceId)
    this._server?.revokeConnections(deviceId)
    await this._attachments.deleteDevice(deviceId)
    await this._audit.append({
      ...(removed ? { deviceId } : {}),
      action: 'device_revoked',
      result: removed ? 'success' : 'failure',
      ...(removed ? {} : { detail: 'device not found' }),
    })
    this._logger.info(`revoke device id=${deviceId} removed=${removed}`)
    await this._refreshAttentionState()
    await this._emitDevices()
  }

  async setDeviceTrust(deviceId: string, trusted: boolean): Promise<void> {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || typeof trusted !== 'boolean') {
      throw new Error('invalid device trust request')
    }
    await this._enqueue(async () => {
      const updated = await this._deviceStore.setTrusted(deviceId, trusted)
      const action = trusted ? 'device_trust_granted' : 'device_trust_revoked'
      if (!updated) {
        await this._appendAudit({
          deviceId,
          action,
          result: 'failure',
          detail: 'device not found',
        })
        await this._emitDevices()
        throw new Error('device not found')
      }
      this._server?.setDeviceTrust(deviceId, trusted)
      this._logger.info(`device trust granted=${trusted} id=${deviceId}`)
      await this._emitDevices()
      await this._appendAudit({ deviceId, action, result: 'success' })
    })
  }

  getRecentAudit(limit: number): Promise<readonly MobileAuditEntry[]> {
    const bounded = Number.isFinite(limit)
      ? Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.floor(limit)))
      : 50
    return this._audit.recent(bounded)
  }

  async getConfig(): Promise<MobileGatewayConfigState> {
    await this._ready.catch(() => undefined)
    return this._configState
  }

  updateConfig(patch: MobileGatewayConfigPatch): Promise<MobileGatewayConfigUpdateResult> {
    if (this._disposed) {
      return Promise.resolve({
        ok: false,
        state: this._configState,
        errors: ['mobile gateway service is disposed'],
      })
    }
    return this._enqueue(async () => {
      const result = await this._configStore.update(patch)
      if (!result.ok) return result
      this._configState = result.state
      await this._applyConfig(result.state.config)
      this._onDidChangeConfig.fire(result.state)
      return result
    })
  }

  getConfigFileUri(): Promise<string> {
    return Promise.resolve(URI.file(this._configFile).toString())
  }

  async ensureConfigFile(): Promise<string> {
    await this._ready.catch(() => undefined)
    await this._configStore.ensureFile()
    return URI.file(this._configFile).toString()
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

  /**
   * WindowMainService is built after the root DI container (it needs the app
   * services), so the gateway receives it through this setter. `newSession`
   * needs it to open a window for a recent-only workspace.
   */
  setWindowProvider(provider: MobileGatewayWindowProvider): void {
    this._windows = provider
  }

  private _openWorkspaces(): readonly {
    windowId: number
    folder: string
    name: string
    authority?: string
  }[] {
    const infos = this._windows?.getOpenWindowInfos() ?? []
    const result: {
      windowId: number
      folder: string
      name: string
      authority?: string
    }[] = []
    for (const info of infos) {
      if (info.folder === null) continue
      const folder = URI.from(info.folder)
      result.push({
        windowId: info.id,
        folder: folder.toString(),
        name: info.name ?? folder.fsPath,
        ...(info.remoteAuthority !== undefined
          ? { authority: info.remoteAuthority }
          : folder.authority
            ? { authority: folder.authority }
            : {}),
      })
    }
    return result
  }

  private async _waitForBridge(
    folder: string,
    authority: string | undefined,
    timeoutMs: number,
  ): Promise<number | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const match = this._openWorkspaces().find((workspace) =>
        isSameWorkspace(workspace, { folder, ...(authority !== undefined ? { authority } : {}) }),
      )
      if (match !== undefined && this._windowBridges.has(match.windowId)) return match.windowId
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_WAIT_INTERVAL_MS))
    }
    return undefined
  }

  /** M2 uses this to fan the inbox projection out to every window. */
  getWindowBridges(): ReadonlyMap<number, IMobileBridgeService> {
    return this._windowBridges
  }

  override dispose(): void {
    this._disposed = true
    this._pairing.cancel()
    this._hub.dispose()
    this._attachments.dispose()
    const server = this._server
    this._server = undefined
    if (server !== undefined) void server.stop()
    super.dispose()
  }

  private _enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this._serial.then(task, task)
    this._serial = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _applyConfig(config: MobileGatewayConfig): Promise<void> {
    this._config = config
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
    const localHostname =
      runtime.bind === 'lan' && runtime.secure ? normalizeLocalHostname() : undefined
    const allowedHosts = buildAllowedHosts({
      bindHost: runtime.host,
      port: runtime.port,
      extraHosts: this._config.allowedHosts,
      ...(localHostname !== undefined ? { localHostnames: [localHostname] } : {}),
    })

    let certificate: LanCertificate | undefined
    if (runtime.secure) {
      try {
        certificate = await ensureLanCertificate({
          dir: join(this._mobileDir, 'tls'),
          addresses: lanCertificateAddresses(runtime.host, localHostname),
          mode: this._config.certificateMode,
          onChmodError: (error) =>
            this._logger.warn(`mobile TLS key chmod 0600 failed: ${error.message}`),
        })
      } catch (err) {
        await this._teardown()
        const message = `无法为局域网档生成 HTTPS 证书：${err instanceof Error ? err.message : String(err)}`
        this._logger.error(message)
        this._setError(message)
        this._recordAudit({ action: 'gateway_error', result: 'failure', detail: message })
        return
      }
    }

    const vapid = await this._vapidPromise
    const runningKey = JSON.stringify({
      host: runtime.host,
      port: runtime.port,
      secure: runtime.secure,
      tlsFingerprint: certificate?.fingerprint,
      tlsMode: this._config.certificateMode,
      caFingerprint: certificate?.ca?.fingerprint,
      allowedHosts,
      localHostname,
      assetsDir: this._assetsDir,
      vapidSubject: this._config.vapidSubject,
    })
    if (this._state === 'running' && runningKey === this._runningKey) return

    await this._teardown()
    this._setState('starting')
    this._boundHost = runtime.host
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
      ...(certificate !== undefined
        ? { tls: { cert: certificate.cert, key: certificate.key } }
        : {}),
      ...(certificate?.ca !== undefined ? { caCertificate: certificate.ca.cert } : {}),
      helloTimeoutMs: HELLO_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      onConnectionsChanged: () => this._handleConnectionsChanged(),
      onNotificationStateChanged: () => {
        void this._refreshAttentionState()
        void this._emitDevices()
      },
      ...(vapid !== undefined ? { vapidPublicKey: vapid.publicKey } : {}),
      onDiagnostic: (event) => this._handleDiagnostic(event),
      hub: this._hub,
      attachments: this._attachments,
    })
    try {
      const { port } = await server.start()
      if (this._disposed) {
        await server.stop()
        return
      }
      this._server = server
      this._router = new MobileNotificationRouter({
        logger: this._logger,
        listTargets: () => this._deviceStore.listNotifyTargets(),
        isPcFocused: () => BrowserWindow.getFocusedWindow() !== null,
        isDeviceVisible: (deviceId) => server.isDeviceVisible(deviceId),
        sendToVisibleDevices: (deviceId, frame) => server.sendToVisibleDevices(deviceId, frame),
        pushSender: this._pushSender,
        ...(vapid !== undefined ? { vapid } : {}),
        subject: this._config.vapidSubject,
        onPushSubscriptionGone: async (deviceId) => {
          await this._deviceStore.removePushSubscription(deviceId)
          await this._refreshAttentionState()
        },
      })
      void this._refreshAttentionState()
      this._listenAddress = `${runtime.host}:${port}`
      this._originsInfo = buildOrigins({
        bind: runtime.bind,
        host: runtime.host,
        port,
        secure: runtime.secure,
        allowedHosts: this._config.allowedHosts,
        ...(localHostname !== undefined ? { localHostname } : {}),
      })
      this._origins = this._originsInfo.urls
      this._certificate = certificate
      this._lanOrigin =
        runtime.bind === 'lan' && runtime.secure ? `https://${runtime.host}:${port}` : undefined
      this._lanHostnameOrigin =
        runtime.bind === 'lan' && runtime.secure && localHostname !== undefined
          ? `https://${localHostname}:${port}`
          : undefined
      this._runningKey = runningKey
      this._state = 'running'
      this._error = undefined
      this._emitStatus()
      this._logger.info(
        `started bind=${runtime.bind} address=${this._listenAddress} secure=${runtime.secure} insecure=${runtime.insecure}`,
      )
      this._recordAudit({
        action: 'gateway_start',
        result: 'success',
        detail: `${runtime.bind} ${this._listenAddress}${runtime.secure ? ' https' : ''}`,
      })
    } catch (err) {
      const message = describeListenError(err, runtime.host, runtime.port)
      this._logger.error(`mobile gateway failed to listen: ${message}`)
      this._server = undefined
      this._listenAddress = undefined
      this._origins = []
      this._originsInfo = { urls: [], trustedSecure: false }
      this._certificate = undefined
      this._lanOrigin = undefined
      this._lanHostnameOrigin = undefined
      this._setError(message)
      this._recordAudit({ action: 'gateway_error', result: 'failure', detail: message })
    }
  }

  private async _teardown(): Promise<void> {
    const server = this._server
    this._server = undefined
    this._router = undefined
    this._runningKey = undefined
    this._listenAddress = undefined
    this._origins = []
    this._originsInfo = { urls: [], trustedSecure: false }
    this._certificate = undefined
    this._lanOrigin = undefined
    this._lanHostnameOrigin = undefined
    this._insecure = false
    this._boundHost = undefined
    this._tlsTrustWarning = undefined
    if (server === undefined) return
    await server.stop()
    this._logger.info('stopped')
    this._recordAudit({ action: 'gateway_stop', result: 'success' })
  }

  private _handleAttention(attention: MobileGatewayAttention): void {
    const router = this._router
    if (router === undefined) return
    void router.notify(attention).catch((err) => {
      this._logger.warn(`mobile notification routing failed: ${String(err)}`)
    })
  }

  /** Hub attention-only mode follows the set of devices with notifications on. */
  private async _refreshAttentionState(): Promise<void> {
    try {
      const targets = await this._deviceStore.listNotifyTargets()
      this._hub.setAttentionNeeded(targets.length > 0)
    } catch (err) {
      this._logger.warn(`failed to read notification devices: ${String(err)}`)
    }
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
      ...(this._lanHostnameOrigin !== undefined
        ? { lanHostnameOrigin: this._lanHostnameOrigin }
        : {}),
      lanAddresses: listLanAddresses(),
      origins: this._origins,
      insecure: this._insecure,
      bind: this._bind,
      capabilities: capabilitiesForOrigins(this._originsInfo),
      connectedDeviceCount: this._server?.getConnectedDeviceCount() ?? 0,
      ...(this._certificate !== undefined
        ? {
            certificate: {
              fingerprint: this._certificate.fingerprint,
              addresses: this._certificate.addresses,
              expiresAt: this._certificate.expiresAt,
              ...(this._certificate.ca !== undefined
                ? {
                    caFingerprint: this._certificate.ca.fingerprint,
                    caExpiresAt: this._certificate.ca.expiresAt,
                  }
                : {}),
            },
          }
        : {}),
      ...(this._lanOrigin !== undefined && this._certificate?.ca !== undefined
        ? { caDownloadUrl: `${this._lanOrigin}${MOBILE_CERT_PATH}` }
        : {}),
      ...(this._tlsTrustWarning !== undefined ? { tlsTrustWarning: this._tlsTrustWarning } : {}),
    }
  }

  /**
   * A client rejected our certificate (alert 46) before HTTP routing. Surface it
   * in the settings page: the phone itself may be stuck on a cached app shell
   * and cannot show any hint.
   */
  private _handleDiagnostic(event: MobileGatewayDiagnosticEvent): void {
    if (event.action !== 'tls_handshake_failed') return
    if (!isCertificateRejection(event.detail)) return
    if (isLocalTlsClient(event.remoteAddress, this._boundHost)) return
    this._tlsTrustWarning = { at: Date.now(), remoteAddress: event.remoteAddress }
    this._emitStatus()
  }

  private async _emitDevices(): Promise<void> {
    try {
      this._onDidChangeDevices.fire(await this.listDevices())
    } catch (err) {
      this._logger.warn(`failed to list devices: ${String(err)}`)
    }
  }

  /** Awaitable audit write that never rejects: a failed write must not undo the state change. */
  private async _appendAudit(input: AuditInput): Promise<void> {
    try {
      await this._audit.append(input)
    } catch (err) {
      this._logger.warn(`audit append failed: ${String(err)}`)
    }
  }

  /** Fire-and-forget audit write; a failed write must never become an unhandled rejection. */
  private _recordAudit(input: AuditInput): void {
    void this._appendAudit(input)
  }

  /** Connection churn changes both the device rows (online flag) and the count in status. */
  private _handleConnectionsChanged(): void {
    this._emitStatus()
    void this._emitDevices()
  }
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

/** Cover the bound address and the PC host name so both URLs validate. */
function lanCertificateAddresses(host: string, localHostname?: string): string[] {
  const addresses = [host]
  if (localHostname !== undefined && !addresses.includes(localHostname)) {
    addresses.push(localHostname)
  }
  return addresses
}

/** Normalized `os.hostname()`; undefined when it cannot be a DNS SAN entry. */
function normalizeLocalHostname(): string | undefined {
  const name = hostname().trim().toLowerCase().replace(/\.$/u, '')
  if (name === '' || name.includes(':') || name.includes('/') || /\s/u.test(name)) return undefined
  return name
}

function describeListenError(err: unknown, host: string, port: number): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用`
  if (code === 'EACCES') return `没有权限监听 ${host}:${port}`
  if (code === 'EADDRNOTAVAIL') return `无法绑定地址 ${host}`
  const message = err instanceof Error ? err.message : String(err)
  return `无法启动手机网关：${message}`
}
