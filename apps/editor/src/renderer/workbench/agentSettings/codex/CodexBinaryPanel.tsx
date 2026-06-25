/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CodexBinaryPanel — the "Binary" category for the built-in Codex agent. Configures
 *  how the agent locates the native codex adapter executable: auto-download
 *  (default), system PATH install, or a custom path. For the download source, also
 *  shows the installed binary version and the latest available version from npm,
 *  with a one-click upgrade button when a newer release is available.
 *  Mirrors claude/BinaryPanel.tsx; differences are the service, config keys, and
 *  the codex wording (no SDK — the pinned version is the download target).
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
  ICodexBinaryService,
  type CodexBinarySource,
  type ICodexBinaryVersionInfo,
} from '../../../../shared/ipc/codexBinaryService.js'
import { useService } from '../../useService.js'
import type { UseCodexConfig } from './useCodexConfig.js'
import styles from '../AgentSettingsEditor.module.css'

export function CodexBinaryPanel(_props: { config: UseCodexConfig }) {
  const config = useService(IConfigurationService)
  const codexBinary = useService(ICodexBinaryService)
  const notifications = useService(INotificationService)
  const host = useService(IHostService)

  const [source, setSourceState] = useState<CodexBinarySource>(
    () => (config.get<string>('acp.codex.source') ?? 'download') as CodexBinarySource,
  )
  const [customPath, setCustomPathState] = useState<string>(
    () => config.get<string>('acp.codex.executablePath') ?? '',
  )
  const [versionInfo, setVersionInfo] = useState<ICodexBinaryVersionInfo | null>(null)
  const [loadingVersion, setLoadingVersion] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<{
    received: number
    total: number
  } | null>(null)

  const progressSubRef = useRef<{ dispose(): void } | null>(null)

  const loadVersionInfo = useCallback(() => {
    setLoadingVersion(true)
    void codexBinary
      .getVersionInfo()
      .then((info) => setVersionInfo(info))
      .finally(() => setLoadingVersion(false))
  }, [codexBinary])

  useEffect(() => {
    loadVersionInfo()
    return () => {
      progressSubRef.current?.dispose()
    }
  }, [loadVersionInfo])

  const changeSource = useCallback(
    (next: CodexBinarySource) => {
      setSourceState(next)
      config.update('acp.codex.source', next, ConfigurationTarget.User)
    },
    [config],
  )

  const commitCustomPath = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (trimmed === (config.get<string>('acp.codex.executablePath') ?? '')) return
      config.update('acp.codex.executablePath', trimmed, ConfigurationTarget.User)
    },
    [config],
  )

  const handleUpgrade = useCallback(
    (targetVersion: string) => {
      if (downloading) return
      setDownloading(true)
      setDownloadProgress(null)
      progressSubRef.current?.dispose()
      progressSubRef.current = codexBinary.onDidChangeProgress((p) => setDownloadProgress(p))

      void codexBinary
        .forceDownload(targetVersion)
        .then(() => {
          loadVersionInfo()
          notifications.notify({
            severity: Severity.Info,
            message: localize(
              'codexBinaryPanel.upgrade.success',
              'codex binary upgraded to {version}.',
              { version: targetVersion },
            ),
          })
        })
        .catch((err: unknown) => {
          notifications.notify({
            severity: Severity.Error,
            message: localize(
              'codexBinaryPanel.upgrade.error',
              'Failed to upgrade codex binary: {message}',
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
    [codexBinary, downloading, loadVersionInfo, notifications],
  )

  return (
    <div className={styles['panel']}>
      {/* ── Binary Source ─────────────────────────────────────────────── */}
      <section className={styles['section']}>
        <h3 className={styles['sectionTitle']}>
          {localize('codexBinaryPanel.source.title', 'Binary source')}
        </h3>
        <div className={styles['radioGroup']}>
          <SourceOption
            value="download"
            current={source}
            label={localize('codexBinaryPanel.source.download', 'Download (recommended)')}
            desc={localize(
              'codexBinaryPanel.source.download.desc',
              'Automatically download the codex binary into the user data folder on first use.',
            )}
            onChange={changeSource}
          />
          <SourceOption
            value="system"
            current={source}
            label={localize('codexBinaryPanel.source.system', 'System')}
            desc={localize(
              'codexBinaryPanel.source.system.desc',
              'Use the `codex` executable found on PATH (you manage updates yourself).',
            )}
            onChange={changeSource}
          />
          <SourceOption
            value="custom"
            current={source}
            label={localize('codexBinaryPanel.source.custom', 'Custom path')}
            desc={localize(
              'codexBinaryPanel.source.custom.desc',
              'Point to a specific codex executable. Useful for testing or multiple installs.',
            )}
            onChange={changeSource}
          />
        </div>

        {source === 'custom' && (
          <div className={styles['field']}>
            <label className={styles['label']}>
              {localize('codexBinaryPanel.customPath', 'Executable path')}
            </label>
            <Input
              value={customPath}
              placeholder={
                host.platform === 'win32' ? 'C:\\path\\to\\codex.exe' : '/usr/local/bin/codex'
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
            {localize('codexBinaryPanel.version.title', 'Version')}
          </h3>
          <VersionInfo
            info={versionInfo}
            loading={loadingVersion}
            downloading={downloading}
            downloadProgress={downloadProgress}
            onUpgrade={handleUpgrade}
          />
        </section>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface SourceOptionProps {
  value: CodexBinarySource
  current: CodexBinarySource
  label: string
  desc: string
  onChange(v: CodexBinarySource): void
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
        name="codexBinarySource"
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
  info: ICodexBinaryVersionInfo | null
  loading: boolean
  downloading: boolean
  downloadProgress: { received: number; total: number } | null
  onUpgrade(version: string): void
}

function VersionInfo({
  info,
  loading,
  downloading,
  downloadProgress,
  onUpgrade,
}: VersionInfoProps) {
  if (loading && !info) {
    return (
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {localize('codexBinaryPanel.version.loading', 'Loading version info…')}
        </span>
      </div>
    )
  }

  if (!info) return null

  const { bundledVersion, installedVersion, latestVersion, prefetchedVersion } = info
  const isUpToDate = latestVersion !== null && installedVersion === latestVersion
  // Offer the pinned version when nothing is installed yet.
  const canDownloadBundled = installedVersion === null
  // Offer the latest version whenever it differs from what's installed and from
  // the pinned one (when pinned === latest a single button is enough).
  const canGetLatest =
    latestVersion !== null && latestVersion !== bundledVersion && installedVersion !== latestVersion

  return (
    <div className={styles['field']}>
      {/* Pinned codex version (always shown) */}
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {localize('codexBinaryPanel.version.pinned', 'Pinned codex: {version}', {
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
            {localize('codexBinaryPanel.version.installed', 'Installed: {version}', {
              version: installedVersion,
            })}
          </span>
        ) : (
          <span className={styles['statusMuted']}>
            {localize('codexBinaryPanel.version.notDownloaded', 'Not downloaded')}
          </span>
        )}
      </div>

      {/* Latest version */}
      <div className={styles['statusRow']}>
        <span className={styles['statusMuted']}>
          {latestVersion !== null
            ? localize('codexBinaryPanel.version.latest', 'Latest: {version}', {
                version: latestVersion,
              })
            : localize(
                'codexBinaryPanel.version.latestUnavailable',
                'Latest: unavailable (network error)',
              )}
        </span>
      </div>

      {/* Download progress */}
      {downloading && (
        <div className={styles['statusRow']}>
          <span className={styles['statusMuted']}>
            {downloadProgress && downloadProgress.total > 0
              ? localize('codexBinaryPanel.version.downloading.pct', 'Downloading… {pct}%', {
                  pct: Math.min(
                    100,
                    Math.floor((downloadProgress.received / downloadProgress.total) * 100),
                  ),
                })
              : downloadProgress
                ? localize('codexBinaryPanel.version.downloading.mb', 'Downloading… {mb} MB', {
                    mb: Math.floor(downloadProgress.received / 1_048_576),
                  })
                : localize('codexBinaryPanel.version.downloading', 'Downloading…')}
          </span>
        </div>
      )}

      {/* Actions */}
      {!downloading && (
        <>
          {canDownloadBundled && canGetLatest && (
            <div className={styles['desc']} style={{ marginTop: 4 }}>
              {localize(
                'codexBinaryPanel.version.chooseHint',
                'Pinned ({bundled}) is the version this build follows and is known to work — safest choice. Latest ({latest}) gets the newest features but may not be fully tested with this build.',
                { bundled: bundledVersion, latest: latestVersion ?? '' },
              )}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {canDownloadBundled && (
              <Button onClick={() => onUpgrade(bundledVersion)}>
                <Download size={14} strokeWidth={2} />
                {prefetchedVersion === bundledVersion
                  ? localize(
                      'codexBinaryPanel.version.downloadReady',
                      'Download {version} (ready)',
                      {
                        version: bundledVersion,
                      },
                    )
                  : localize('codexBinaryPanel.version.download', 'Download {version}', {
                      version: bundledVersion,
                    })}
              </Button>
            )}
            {canGetLatest && latestVersion !== null && (
              <Button onClick={() => onUpgrade(latestVersion)}>
                <ArrowUpCircle size={14} strokeWidth={2} />
                {prefetchedVersion === latestVersion
                  ? localize(
                      'codexBinaryPanel.version.upgradeReady',
                      'Upgrade to {version} (ready)',
                      {
                        version: latestVersion,
                      },
                    )
                  : installedVersion === null
                    ? localize('codexBinaryPanel.version.download', 'Download {version}', {
                        version: latestVersion,
                      })
                    : localize('codexBinaryPanel.version.upgrade', 'Upgrade to {version}', {
                        version: latestVersion,
                      })}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
