/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BinaryPanel — the "Binary" category. Configures how the built-in ACP agent
 *  locates the native Claude executable: auto-download (default), system PATH
 *  install, or a custom path. For the download source, also shows the installed
 *  binary version and the latest available version from npm, with a one-click
 *  upgrade button when a newer release is available. Downloaded versions stay on
 *  disk, so switching between the bundled and the latest version is instant.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, CircleAlert, Download, Undo2 } from 'lucide-react'
import {
  ConfigurationTarget,
  IConfigurationService,
  IHostService,
  INotificationService,
  Severity,
  localize,
} from '@universe-editor/platform'
import { Button, Input } from '@universe-editor/workbench-ui'
import {
  IClaudeBinaryService,
  type ClaudeBinarySource,
  type IClaudeBinaryDownload,
  type IClaudeBinaryVersionInfo,
} from '../../../../shared/ipc/claudeBinaryService.js'
import { useEventSubscription, useService } from '../../useService.js'
import { useRemoteAuthority } from '../../useRemoteAuthority.js'
import { computeBinaryVersionActions, deriveBinaryActionState } from '../binaryVersionActions.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import styles from '../AgentSettingsEditor.module.css'

export function BinaryPanel(_props: { config: UseClaudeConfig }) {
  const config = useService(IConfigurationService)
  const claudeBinary = useService(IClaudeBinaryService)
  const notifications = useService(INotificationService)
  const host = useService(IHostService)
  const authority = useRemoteAuthority()

  const [source, setSourceState] = useState<ClaudeBinarySource>(
    () => (config.get<string>('acp.claude.source') ?? 'download') as ClaudeBinarySource,
  )
  const [customPath, setCustomPathState] = useState<string>(
    () => config.get<string>('acp.claude.executablePath') ?? '',
  )
  const [versionInfo, setVersionInfo] = useState<IClaudeBinaryVersionInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [downloads, setDownloads] = useState<readonly IClaudeBinaryDownload[]>([])

  const downloadsRef = useRef<readonly IClaudeBinaryDownload[]>([])
  /** Set once a live event lands, so a slower snapshot can't stamp stale state over it. */
  const sawEventRef = useRef(false)

  const loadVersionInfo = useCallback(() => {
    setLoadingVersion(true)
    setLoadError(null)
    void claudeBinary
      .getVersionInfo(authority)
      .then((info) => {
        setVersionInfo(info)
        if (!sawEventRef.current) {
          downloadsRef.current = info.downloads
          setDownloads(info.downloads)
        }
      })
      .catch((err: unknown) => setLoadError(String(err)))
      .finally(() => setLoadingVersion(false))
  }, [claudeBinary, authority])

  useEffect(() => {
    // A different host has a different download set entirely, so drop what we
    // have before re-reading. (Info itself is kept — clearing it would flash
    // "Loading…" on every refresh.)
    sawEventRef.current = false
    downloadsRef.current = []
    setDownloads([])
    loadVersionInfo()
  }, [loadVersionInfo])

  // Long-lived subscription, not one scoped to a click: the download keeps running
  // in the main process while this panel is unmounted, so the state has to be
  // re-readable on the next mount (snapshot above) and live while mounted (here).
  useEventSubscription(
    () =>
      claudeBinary.onDidChangeDownload((e) => {
        if (e.authority !== authority) return
        const wasBusy = downloadsRef.current.length > 0
        sawEventRef.current = true
        downloadsRef.current = e.downloads
        setDownloads(e.downloads)
        // The queue drained → the installed version may have changed. A switch to
        // an already-downloaded version emits no download at all, so this refresh
        // (plus the one in handleUpgrade) is the only signal for it.
        if (wasBusy && e.downloads.length === 0) loadVersionInfo()
      }),
    [claudeBinary, authority, loadVersionInfo],
  )

  const changeSource = useCallback(
    (next: ClaudeBinarySource) => {
      setSourceState(next)
      config.update('acp.claude.source', next, ConfigurationTarget.User)
    },
    [config],
  )

  const commitCustomPath = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (trimmed === (config.get<string>('acp.claude.executablePath') ?? '')) return
      config.update('acp.claude.executablePath', trimmed, ConfigurationTarget.User)
    },
    [config],
  )

  const handleUpgrade = useCallback(
    (targetVersion: string) => {
      // The store de-dupes downloads by version, so a repeat click can't start a
      // second one — this just skips the round-trip.
      if (downloadsRef.current.some((d) => d.version === targetVersion)) return
      void claudeBinary
        .forceDownload(targetVersion, authority)
        .then(() => {
          loadVersionInfo()
          notifications.notify({
            severity: Severity.Info,
            message: localize(
              'binaryPanel.upgrade.success',
              'Claude binary switched to {version}.',
              { version: targetVersion },
            ),
          })
        })
        .catch((err: unknown) => {
          notifications.notify({
            severity: Severity.Error,
            message: localize(
              'binaryPanel.upgrade.error',
              'Failed to upgrade Claude binary: {message}',
              { message: String(err) },
            ),
          })
        })
    },
    [claudeBinary, loadVersionInfo, notifications, authority],
  )

  const isRemote = authority !== undefined

  return (
    <div className={styles['panel']}>
      {isRemote && (
        <div className={styles['desc']}>
          {localize(
            'binaryPanel.remoteNotice',
            "Remote workspace: this page manages the Claude binary on the remote host. It is downloaded into the remote server's data folder.",
          )}
        </div>
      )}
      {/* ── Binary Source ─────────────────────────────────────────────── */}
      {!isRemote && (
        <section className={styles['section']}>
          <h3 className={styles['sectionTitle']}>
            {localize('binaryPanel.source.title', 'Binary source')}
          </h3>
          <div className={styles['radioGroup']}>
            <SourceOption
              value="download"
              current={source}
              label={localize('binaryPanel.source.download', 'Download (recommended)')}
              desc={localize(
                'binaryPanel.source.download.desc',
                'Automatically download the Claude binary into the user data folder on first use.',
              )}
              onChange={changeSource}
            />
            <SourceOption
              value="system"
              current={source}
              label={localize('binaryPanel.source.system', 'System')}
              desc={localize(
                'binaryPanel.source.system.desc',
                'Use the `claude` executable found on PATH (you manage updates yourself).',
              )}
              onChange={changeSource}
            />
            <SourceOption
              value="custom"
              current={source}
              label={localize('binaryPanel.source.custom', 'Custom path')}
              desc={localize(
                'binaryPanel.source.custom.desc',
                'Point to a specific Claude executable. Useful for testing or multiple installs.',
              )}
              onChange={changeSource}
            />
          </div>

          {source === 'custom' && (
            <div className={styles['field']}>
              <label className={styles['label']}>
                {localize('binaryPanel.customPath', 'Executable path')}
              </label>
              <Input
                value={customPath}
                placeholder={
                  host.platform === 'win32' ? 'C:\\path\\to\\claude.exe' : '/usr/local/bin/claude'
                }
                onChange={(e) => setCustomPathState(e.target.value)}
                onBlur={() => commitCustomPath(customPath)}
              />
            </div>
          )}
        </section>
      )}

      {/* ── Version ───────────────────────────────────────────────────── */}
      {(isRemote || source === 'download') && (
        <section className={styles['section']}>
          <h3 className={styles['sectionTitle']}>
            {localize('binaryPanel.version.title', 'Version')}
          </h3>
          {/* Rendered outside the info branch: a download reported by the service
              event must not disappear because the metadata load is slow or failed. */}
          <DownloadRows downloads={downloads} />
          <VersionInfo
            info={versionInfo}
            downloads={downloads}
            loadError={loadError}
            loading={loadingVersion}
            onUpgrade={handleUpgrade}
          />
        </section>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface SourceOptionProps {
  value: ClaudeBinarySource
  current: ClaudeBinarySource
  label: string
  desc: string
  onChange(v: ClaudeBinarySource): void
}

function SourceOption({ value, current, label, desc, onChange }: SourceOptionProps) {
  const active = value === current
  return (
    <label
      className={`${styles['radioItem']} ${active ? styles['radioItemActive'] : ''}`}
      onClick={() => onChange(value)}
    >
      <input
        type="radio"
        name="binarySource"
        value={value}
        checked={active}
        onChange={() => onChange(value)}
        style={{ marginTop: 2 }}
      />
      <div className={styles['radioBody']}>
        <span className={styles['radioTitle']}>{label}</span>
        <span className={styles['desc']}>{desc}</span>
      </div>
    </label>
  )
}

function DownloadRows({ downloads }: { downloads: readonly IClaudeBinaryDownload[] }) {
  if (downloads.length === 0) return null
  return (
    <>
      {downloads.map((d) => (
        <div className={styles['statusRow']} key={d.version}>
          <span className={styles['statusMuted']}>
            {d.total > 0
              ? localize('binaryPanel.version.downloading.pct', 'Downloading {version}… {pct}%', {
                  version: d.version,
                  pct: Math.min(100, Math.floor((d.received / d.total) * 100)),
                })
              : d.received > 0
                ? localize('binaryPanel.version.downloading.mb', 'Downloading {version}… {mb} MB', {
                    version: d.version,
                    mb: Math.floor(d.received / 1_048_576),
                  })
                : localize('binaryPanel.version.downloading', 'Downloading {version}…', {
                    version: d.version,
                  })}
          </span>
        </div>
      ))}
    </>
  )
}

interface VersionInfoProps {
  info: IClaudeBinaryVersionInfo | null
  /** Live in-flight set — not `info.downloads`, which is only a mount-time snapshot. */
  downloads: readonly IClaudeBinaryDownload[]
  loadError: string | null
  loading: boolean
  onUpgrade(version: string): void
}

function VersionInfo({ info, downloads, loadError, loading, onUpgrade }: VersionInfoProps) {
  if (loading && !info) {
    return (
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {localize('binaryPanel.version.loading', 'Loading version info…')}
        </span>
      </div>
    )
  }

  if (!info) {
    if (loadError) {
      return (
        <div className={styles['statusRow']}>
          <span className={styles['statusMuted']}>
            {localize('binaryPanel.version.loadError', 'Version info unavailable: {message}', {
              message: loadError,
            })}
          </span>
        </div>
      )
    }
    return null
  }

  const { bundledVersion, installedVersion, latestVersion, downloadedVersions } = info
  const isUpToDate = latestVersion !== null && installedVersion === latestVersion
  const { showDownloadBundled, showRevertToBundled, showLatest } = computeBinaryVersionActions(info)
  // `downloads` is live, so a download this panel started (or one already running
  // when it mounted) swaps its own button for the progress row immediately.
  const diskState = { downloadedVersions, downloads }
  const bundledState = deriveBinaryActionState(bundledVersion, diskState)
  const latestState =
    latestVersion !== null ? deriveBinaryActionState(latestVersion, diskState) : null

  return (
    <div className={styles['field']}>
      {/* Bundled SDK version (always shown) */}
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {localize('binaryPanel.version.sdk', 'ACP SDK: {version}', {
            version: bundledVersion,
          })}
        </span>
      </div>

      {/* Installed version */}
      <div className={styles['statusRow']}>
        {installedVersion !== null ? (
          <span className={isUpToDate ? styles['statusOk'] : styles['statusWarn']}>
            {isUpToDate ? (
              <CheckCircle2 size={13} strokeWidth={2} />
            ) : (
              <CircleAlert size={13} strokeWidth={2} />
            )}
            {localize('binaryPanel.version.installed', 'Installed: {version}', {
              version: installedVersion,
            })}
          </span>
        ) : (
          <span className={styles['statusMuted']}>
            {localize('binaryPanel.version.notDownloaded', 'Not downloaded')}
          </span>
        )}
      </div>

      {/* Latest version */}
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {latestVersion !== null
            ? localize('binaryPanel.version.latest', 'Latest: {version}', {
                version: latestVersion,
              })
            : localize(
                'binaryPanel.version.latestUnavailable',
                'Latest: unavailable (network error)',
              )}
        </span>
      </div>

      {/* Versions already on disk — a switch to one of these needs no download */}
      {downloadedVersions.length > 0 && (
        <div className={styles['statusRow']}>
          <span className={styles['statusMuted']}>
            {localize('binaryPanel.version.downloadedLocally', 'Available locally: {versions}', {
              versions: downloadedVersions.join(', '),
            })}
          </span>
        </div>
      )}

      {/* Actions */}
      {showDownloadBundled && showLatest && (
        <div className={styles['desc']} style={{ marginTop: 4 }}>
          {localize(
            'binaryPanel.version.chooseHint',
            'Bundled ({bundled}) is verified to match this build’s ACP SDK — safest choice. Latest ({latest}) gets the newest features but may not be fully tested with this build.',
            { bundled: bundledVersion, latest: latestVersion ?? '' },
          )}
        </div>
      )}
      {showRevertToBundled && (
        <div className={styles['desc']} style={{ marginTop: 4 }}>
          {localize(
            'binaryPanel.version.revertHint',
            'The installed version differs from the one verified against this build’s ACP SDK. Revert if the agent fails to start or behaves unexpectedly.',
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        {showDownloadBundled && !bundledState.downloading && (
          <Button onClick={() => onUpgrade(bundledVersion)}>
            <Download size={14} strokeWidth={2} />
            {bundledState.onDisk
              ? localize(
                  'binaryPanel.version.downloadReady',
                  'Install {version} (already downloaded)',
                  { version: bundledVersion },
                )
              : localize('binaryPanel.version.download', 'Download {version}', {
                  version: bundledVersion,
                })}
          </Button>
        )}
        {showRevertToBundled && !bundledState.downloading && (
          <Button onClick={() => onUpgrade(bundledVersion)}>
            <Undo2 size={14} strokeWidth={2} />
            {bundledState.onDisk
              ? localize(
                  'binaryPanel.version.revertReady',
                  'Revert to {version} (already downloaded)',
                  { version: bundledVersion },
                )
              : localize('binaryPanel.version.revert', 'Revert to {version}', {
                  version: bundledVersion,
                })}
          </Button>
        )}
        {showLatest &&
          latestVersion !== null &&
          latestState !== null &&
          !latestState.downloading && (
            <Button onClick={() => onUpgrade(latestVersion)}>
              <Download size={14} strokeWidth={2} />
              {latestState.onDisk
                ? localize(
                    'binaryPanel.version.upgradeReady',
                    'Switch to {version} (already downloaded)',
                    { version: latestVersion },
                  )
                : installedVersion === null
                  ? localize('binaryPanel.version.download', 'Download {version}', {
                      version: latestVersion,
                    })
                  : localize('binaryPanel.version.upgrade', 'Upgrade to {version}', {
                      version: latestVersion,
                    })}
            </Button>
          )}
      </div>
    </div>
  )
}
