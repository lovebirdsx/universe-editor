/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionMcpServersService — live owner of the extension-contributed MCP
 *  server record (see extensionMcpServers.ts for the pure resolver). Fed the
 *  scanned extension DTOs by ExtensionsContribution on every host (re)boot and
 *  re-resolves on its own when a `whenConfiguration` gate key changes or when
 *  Workspace Trust is granted — a grant only replays activation on the host,
 *  it does NOT re-emit contributions, so the gate must be recomputed here.
 *
 *  AcpSessionService prepends `rawRecord` to its settings layers (lowest
 *  priority) and refreshes the definition pool on `onDidChange`.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  Emitter,
  IConfigurationService,
  ILoggerService,
  IWorkspaceTrustManagementService,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { IEnvironmentSnapshotService } from '../../../shared/ipc/environmentSnapshotService.js'
import { resolveExtensionMcpServerRecord } from './extensionMcpServers.js'

export interface IExtensionMcpServersService {
  readonly _serviceBrand: undefined
  /** Current resolved record, shaped like the `acp.mcpServers` setting. */
  readonly rawRecord: Readonly<Record<string, unknown>>
  /**
   * Resolves once the first resolve completed (including the one-shot execPath
   * snapshot fetch). Session creation awaits this so a cold start doesn't race
   * an empty record.
   */
  readonly whenReady: Promise<void>
  /** Fires when the resolved record actually changed. */
  readonly onDidChange: Event<void>
  /** Called by ExtensionsContribution with every (re)applied contribution set. */
  setContributions(extensions: readonly IExtensionDescriptionDto[]): void
}

export const IExtensionMcpServersService = createDecorator<IExtensionMcpServersService>(
  'extensionMcpServersService',
)

export class ExtensionMcpServersService extends Disposable implements IExtensionMcpServersService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange = this._onDidChange.event

  private _extensions: readonly IExtensionDescriptionDto[] = []
  private _execPath: string | undefined
  private _rawRecord: Readonly<Record<string, unknown>> = {}
  /** Gate keys referenced by the current contribution set, for cheap config-change filtering. */
  private _gateKeys: ReadonlySet<string> = new Set()

  readonly whenReady: Promise<void>

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IWorkspaceTrustManagementService
    private readonly _workspaceTrust: IWorkspaceTrustManagementService,
    @IEnvironmentSnapshotService private readonly _envSnapshot: IEnvironmentSnapshotService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'extensionMcp', name: 'Extension MCP Servers' })

    this.whenReady = this._init()

    this._register(
      this._config.onDidChangeConfiguration((e) => {
        for (const key of this._gateKeys) {
          if (e.affectsConfiguration(key)) {
            this._recompute()
            return
          }
        }
      }),
    )
    this._register(this._workspaceTrust.onDidChangeTrust(() => this._recompute()))
  }

  get rawRecord(): Readonly<Record<string, unknown>> {
    return this._rawRecord
  }

  setContributions(extensions: readonly IExtensionDescriptionDto[]): void {
    this._extensions = extensions
    const gateKeys = new Set<string>()
    for (const ext of extensions) {
      for (const entry of Object.values(ext.contributes.mcpServers ?? {})) {
        if (typeof entry?.whenConfiguration === 'string') gateKeys.add(entry.whenConfiguration)
      }
    }
    this._gateKeys = gateKeys
    this._recompute()
  }

  private async _init(): Promise<void> {
    try {
      this._execPath = (await this._envSnapshot.getSnapshot()).execPath
    } catch (err) {
      // Degraded: `${execPath}` entries keep the variable verbatim and are
      // skipped downstream with a warning — never block session creation.
      this._logger.warn(`environment snapshot failed: ${(err as Error).message}`)
      this._execPath = ''
    }
    this._recompute()
  }

  private _recompute(): void {
    // Contributions may land before the execPath snapshot; _init recomputes.
    if (this._execPath === undefined) return
    const next = resolveExtensionMcpServerRecord(
      this._extensions,
      {
        execPath: this._execPath,
        isWorkspaceTrusted: this._workspaceTrust.isWorkspaceTrusted(),
        getConfiguration: (key) => this._config.get(key),
      },
      (m) => this._logger.warn(m),
    )
    if (JSON.stringify(next) === JSON.stringify(this._rawRecord)) return
    this._rawRecord = next
    this._logger.info(`extension mcp servers resolved: [${Object.keys(next).join(', ')}]`)
    this._onDidChange.fire()
  }
}
