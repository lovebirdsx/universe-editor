/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionEditor — the extension detail page (mirrors VSCode's Extension
 *  Editor). Header (icon / name / publisher / stats / install-uninstall action)
 *  plus tabs: README (from the gallery), and Contributions (read straight from
 *  the manifest — commands / configuration / keybindings the extension adds). All
 *  data comes through IExtensionsWorkbenchService; the page reads live, no state.
 *
 *  Honest-boundary note: the header shows a plain-language capability warning —
 *  external extensions run with near-native Node capabilities. We never imply a
 *  sandbox (see docs 05-security-and-trust).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react'
import { Package } from 'lucide-react'
import { type IEditorInput, localize } from '@universe-editor/platform'
import { Button, Spinner, cx } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import {
  IExtensionsWorkbenchService,
  type IExtensionEntry,
} from '../../services/extensionsWorkbench/ExtensionsWorkbenchService.js'
import { ExtensionEditorInput } from '../../services/editor/ExtensionEditorInput.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import { useExtensionIcon } from './useExtensionIcon.js'
import styles from './ExtensionEditor.module.css'

type Tab = 'readme' | 'contributions'

export function ExtensionEditor({ input }: { input: IEditorInput }) {
  const service = useService(IExtensionsWorkbenchService)
  const extensionId = (input as ExtensionEditorInput).extensionId

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const sub = service.onDidChange(() => setTick((t) => t + 1))
    void service.refreshInstalled()
    return () => sub.dispose()
  }, [service])

  const entry = service.find(extensionId)
  const [tab, setTab] = useState<Tab>('readme')

  if (!entry) {
    return (
      <div className={styles.container}>
        <div className={styles.missing}>
          {localize('extensions.detail.missing', 'Extension {id} is not available', {
            id: extensionId,
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container} data-testid="extension-editor" data-tick={tick}>
      <Header entry={entry} service={service} />
      <div className={styles.tabs}>
        <TabButton active={tab === 'readme'} onClick={() => setTab('readme')}>
          {localize('extensions.detail.readme', 'Details')}
        </TabButton>
        <TabButton active={tab === 'contributions'} onClick={() => setTab('contributions')}>
          {localize('extensions.detail.contributions', 'Contributions')}
        </TabButton>
      </div>
      <div className={styles.body}>
        {tab === 'readme' ? (
          <ReadmePanel entry={entry} service={service} />
        ) : (
          <ContributionsPanel entry={entry} />
        )}
      </div>
    </div>
  )
}

function Header({
  entry,
  service,
}: {
  entry: IExtensionEntry
  service: IExtensionsWorkbenchService
}) {
  const iconUrl = useExtensionIcon(entry)
  return (
    <div className={styles.header}>
      <div className={styles.headerIcon}>
        {iconUrl ? <img src={iconUrl} alt="" width={64} height={64} /> : <Package size={56} />}
      </div>
      <div className={styles.headerMain}>
        <div className={styles.headerTitle}>
          <span className={styles.headerName}>{entry.displayName}</span>
          <span className={styles.headerVersion}>v{entry.version}</span>
        </div>
        <div className={styles.headerMeta}>
          <span>{entry.publisherDisplayName ?? entry.publisher}</span>
          {entry.installCount !== undefined && (
            <span>
              {localize('extensions.detail.installs', '{count} installs', {
                count: entry.installCount,
              })}
            </span>
          )}
          {entry.rating !== undefined && <span>★ {entry.rating.toFixed(1)}</span>}
        </div>
        <div className={styles.headerActions}>
          {entry.installing ? (
            <Spinner size={16} />
          ) : entry.installed ? (
            <Button variant="secondary" onClick={() => void service.uninstall(entry)}>
              {localize('extensions.uninstall', 'Uninstall')}
            </Button>
          ) : (
            <Button onClick={() => void service.install(entry)}>
              {localize('extensions.install', 'Install')}
            </Button>
          )}
        </div>
        <div className={styles.warning}>
          {localize(
            'extensions.detail.capabilityWarning',
            'This extension runs with near-native access to your files and network. Only install extensions from publishers you trust.',
          )}
        </div>
      </div>
    </div>
  )
}

function ReadmePanel({
  entry,
  service,
}: {
  entry: IExtensionEntry
  service: IExtensionsWorkbenchService
}) {
  const [readme, setReadme] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void service.getReadme(entry).then((text) => {
      if (alive) setReadme(text)
    })
    return () => {
      alive = false
    }
  }, [entry, service])

  if (readme === undefined) return <Spinner size={16} />
  if (!readme.trim()) {
    return (
      <div className={styles.empty}>
        {entry.description || localize('extensions.detail.noReadme', 'No details available')}
      </div>
    )
  }
  return <MarkdownView text={readme} />
}

function ContributionsPanel({ entry }: { entry: IExtensionEntry }) {
  const contributes = entry.local?.manifest.contributes
  const commands = useMemo(() => contributes?.commands ?? [], [contributes])
  const configuration = useMemo(() => {
    const config = contributes?.configuration
    if (!config) return []
    const props = Array.isArray(config)
      ? config.flatMap((c) => Object.keys(c.properties ?? {}))
      : Object.keys(config.properties ?? {})
    return props
  }, [contributes])
  const keybindings = useMemo(() => contributes?.keybindings ?? [], [contributes])

  if (!entry.installed) {
    return (
      <div className={styles.empty}>
        {localize(
          'extensions.detail.contributionsAfterInstall',
          'Install this extension to see what it contributes',
        )}
      </div>
    )
  }

  return (
    <div className={styles.contributions}>
      <ContributionSection
        title={localize('extensions.detail.commands', 'Commands')}
        rows={commands.map((c) => c.title ?? c.command)}
      />
      <ContributionSection
        title={localize('extensions.detail.settings', 'Settings')}
        rows={configuration}
      />
      <ContributionSection
        title={localize('extensions.detail.keybindings', 'Keybindings')}
        rows={keybindings.map((k) => `${k.key} → ${k.command}`)}
      />
    </div>
  )
}

function ContributionSection({ title, rows }: { title: string; rows: string[] }) {
  if (rows.length === 0) return null
  return (
    <div className={styles.contribSection}>
      <div className={styles.contribTitle}>{title}</div>
      <ul className={styles.contribList}>
        {rows.map((row, i) => (
          <li key={i}>{row}</li>
        ))}
      </ul>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button className={cx(styles.tab, active && styles.tabActive)} onClick={onClick}>
      {children}
    </button>
  )
}
