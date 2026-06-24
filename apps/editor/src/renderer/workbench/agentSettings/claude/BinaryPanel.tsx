/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BinaryPanel — the "Binary" category. Configures how the built-in ACP agent
 *  locates the native Claude executable: auto-download (default), system PATH
 *  install, or a custom path. For the download source, also shows the installed
 *  binary version and the latest available version from npm, with a one-click
 *  upgrade button when a newer release is available.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpCircle, CheckCircle2, CircleAlert, Download } from 'lucide-react'
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
  type IClaudeBinaryVersionInfo,
} from '../../../../shared/ipc/claudeBinaryService.js'
import { useService } from '../../useService.js'
import type { UseClaudeConfig } from './useClaudeConfig.js'
import styles from '../AgentSettingsEditor.module.css'

export function BinaryPanel(_props: { config: UseClaudeConfig }) {
  const config = useService(IConfigurationService)
  const claudeBinary = useService(IClaudeBinaryService)
  const notifications = useService(INotificationService)
  const host = useService(IHostService)

  const [source, setSourceState] = useState<ClaudeBinarySource>(
    () => (config.get<string>('acp.claude.source') ?? 'download') as ClaudeBinarySource,
  )
  const [customPath, setCustomPathState] = useState<string>(
    () => config.get<string>('acp.claude.executablePath') ?? '',
  )
  const [versionInfo, setVersionInfo] = useState<IClaudeBinaryVersionInfo | null>(null)
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{
    received: number
    total: number
  } | null>(null)

  const progressSubRef = useRef<{ dispose(): void } | null>(null)

  const loadVersionInfo = useCallback(() => {
    setLoadingVersion(true)
    void claudeBinary
      .getVersionInfo()
      .then((info) => setVersionInfo(info))
      .finally(() => setLoadingVersion(false))
  }, [claudeBinary])

  useEffect(() => {
    loadVersionInfo()
    return () => {
      progressSubRef.current?.dispose()
    }
  }, [loadVersionInfo])

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
      if (downloading) return
      setDownloading(true)
      setDownloadProgress(null)
      progressSubRef.current?.dispose()
      progressSubRef.current = claudeBinary.onDidChangeProgress((p) => setDownloadProgress(p))

      void claudeBinary
        .forceDownload(targetVersion)
        .then(() => {
          loadVersionInfo()
          notifications.notify({
            severity: Severity.Info,
            message: localize(
              'binaryPanel.upgrade.success',
              'Claude binary upgraded to {version}.',
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
        .finally(() => {
          progressSubRef.current?.dispose()
          progressSubRef.current = null
          setDownloading(false)
          setDownloadProgress(null)
        })
    },
    [claudeBinary, downloading, loadVersionInfo, notifications],
  )

  const handleInitialDownload = useCallback(() => {
    if (!versionInfo || downloading) return
    handleUpgrade(versionInfo.bundledVersion)
  }, [downloading, handleUpgrade, versionInfo])

  return (
    <div className={styles['panel']}>
      {/* ── Binary Source ─────────────────────────────────────────────── */}
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

      {/* ── Version ───────────────────────────────────────────────────── */}
      {source === 'download' && (
        <section className={styles['section']}>
          <h3 className={styles['sectionTitle']}>
            {localize('binaryPanel.version.title', 'Version')}
          </h3>
          <VersionInfo
            info={versionInfo}
            loading={loadingVersion}
            downloading={downloading}
            downloadProgress={downloadProgress}
            onUpgrade={handleUpgrade}
            onDownload={handleInitialDownload}
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

interface VersionInfoProps {
  info: IClaudeBinaryVersionInfo | null
  loading: boolean
  downloading: boolean
  downloadProgress: { received: number; total: number } | null
  onUpgrade(version: string): void
  onDownload(): void
}

function VersionInfo({
  info,
  loading,
  downloading,
  downloadProgress,
  onUpgrade,
  onDownload,
}: VersionInfoProps) {
  if (loading && !info) {
    return (
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {localize('binaryPanel.version.loading', 'Loading version info…')}
        </span>
      </div>
    )
  }

  if (!info) return null

  const { bundledVersion, installedVersion, latestVersion } = info
  const isUpToDate = latestVersion !== null && installedVersion === latestVersion
  const canUpgrade =
    latestVersion !== null && installedVersion !== null && installedVersion !== latestVersion

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

      {/* Download progress */}
      {downloading && (
        <div className={styles['statusRow']}>
          <span className={styles['statusMuted']}>
            {downloadProgress && downloadProgress.total > 0
              ? localize('binaryPanel.version.downloading.pct', 'Downloading… {pct}%', {
                  pct: Math.min(
                    100,
                    Math.floor((downloadProgress.received / downloadProgress.total) * 100),
                  ),
                })
              : downloadProgress
                ? localize('binaryPanel.version.downloading.mb', 'Downloading… {mb} MB', {
                    mb: Math.floor(downloadProgress.received / 1_048_576),
                  })
                : localize('binaryPanel.version.downloading', 'Downloading…')}
          </span>
        </div>
      )}

      {/* Actions */}
      {!downloading && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          {installedVersion === null && (
            <Button onClick={onDownload}>
              <Download size={14} strokeWidth={2} />
              {localize('binaryPanel.version.download', 'Download {version}', {
                version: bundledVersion,
              })}
            </Button>
          )}
          {canUpgrade && latestVersion !== null && (
            <Button onClick={() => onUpgrade(latestVersion)}>
              <ArrowUpCircle size={14} strokeWidth={2} />
              {localize('binaryPanel.version.upgrade', 'Upgrade to {version}', {
                version: latestVersion,
              })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
