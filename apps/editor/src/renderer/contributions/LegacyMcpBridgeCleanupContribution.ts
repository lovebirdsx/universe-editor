/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One-shot cleanup of the legacy MCP bridge settings entry. Old versions of the
 *  universe-editor-mcp-bridge extension wrote `acp.mcpServers["universe-editor"]`
 *  into the USER settings.json on every activation; the server is now injected
 *  as a declarative runtime contribution (`contributes.mcpServers`), so the
 *  stale entry would forever shadow it — pointing at a possibly outdated
 *  extension path. Remove it iff its shape matches exactly what the old
 *  extension wrote; anything the user touched is preserved. Even a false
 *  positive is harmless: the declarative contribution injects an equivalent
 *  server.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  IConfigurationService,
  ILoggerService,
  IStorageService,
  IUriIdentityService,
  StorageScope,
  type ILogger,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IEnvironmentSnapshotService } from '../../shared/ipc/environmentSnapshotService.js'
import { mcpServerRawToRecord, writeMcpServerEntry } from '../services/acp/acpMcpServers.js'

export const LEGACY_MCP_BRIDGE_CLEANED_KEY = 'acp.legacyMcpBridgeCleaned'
const CONFIG_KEY = 'acp.mcpServers'
const SERVER_NAME = 'universe-editor'
const BRIDGE_ARG_SUFFIX = '/resources/bridge/bridge.mjs'

/**
 * True iff `entry` is byte-for-byte the shape the legacy extension wrote:
 * `{ command: <execPath>, args: [<extDir>/resources/bridge/bridge.mjs],
 *    env: { ELECTRON_RUN_AS_NODE: '1' } }`. Any extra key (`disabled`, `type`,
 * …) or any edited value means the user touched it — keep it. Path fields are
 * compared through `pathKey` (IUriIdentityService.getPathComparisonKey).
 */
export function isLegacyBridgeEntry(
  entry: unknown,
  execPath: string,
  pathKey: (p: string) => string,
): boolean {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false
  const o = entry as Record<string, unknown>
  const allowed = new Set(['command', 'args', 'env'])
  if (!Object.keys(o).every((k) => allowed.has(k))) return false

  if (typeof o.command !== 'string' || pathKey(o.command) !== pathKey(execPath)) return false
  if (!Array.isArray(o.args) || o.args.length !== 1 || typeof o.args[0] !== 'string') return false
  if (!pathKey(o.args[0]).endsWith(BRIDGE_ARG_SUFFIX)) return false

  if (o.env == null || typeof o.env !== 'object' || Array.isArray(o.env)) return false
  const env = o.env as Record<string, unknown>
  return Object.keys(env).length === 1 && env['ELECTRON_RUN_AS_NODE'] === '1'
}

export class LegacyMcpBridgeCleanupContribution implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IConfigurationService private readonly _config: IConfigurationService,
    @IStorageService private readonly _storage: IStorageService,
    @IEnvironmentSnapshotService private readonly _envSnapshot: IEnvironmentSnapshotService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = loggerService.createLogger({ id: 'extensionMcp', name: 'Extension MCP Servers' })
    void this._run()
  }

  dispose(): void {}

  private async _run(): Promise<void> {
    try {
      const cleaned = await this._storage.get<boolean>(
        LEGACY_MCP_BRIDGE_CLEANED_KEY,
        StorageScope.GLOBAL,
      )
      if (cleaned === true) return

      // The legacy extension wrote through `_workbench.updateConfiguration`,
      // which always lands in the User layer — no other layer needs scanning.
      const raw = this._config.getLayerSnapshot(ConfigurationTarget.User)[CONFIG_KEY]
      const entry = mcpServerRawToRecord(raw)[SERVER_NAME]
      if (entry !== undefined) {
        const { execPath } = await this._envSnapshot.getSnapshot()
        if (
          isLegacyBridgeEntry(entry, execPath, (p) => this._uriIdentity.getPathComparisonKey(p))
        ) {
          this._config.update(
            CONFIG_KEY,
            writeMcpServerEntry(raw, SERVER_NAME, undefined),
            ConfigurationTarget.User,
          )
          this._logger.info(`removed legacy "${SERVER_NAME}" entry from user settings`)
        } else {
          this._logger.info(`legacy "${SERVER_NAME}" entry was user-modified, kept`)
        }
      }
      await this._storage.set(LEGACY_MCP_BRIDGE_CLEANED_KEY, true, StorageScope.GLOBAL)
    } catch (err) {
      // Flag NOT set — the cleanup retries on the next launch.
      this._logger.warn(`legacy mcp bridge cleanup failed: ${(err as Error).message}`)
    }
  }
}
