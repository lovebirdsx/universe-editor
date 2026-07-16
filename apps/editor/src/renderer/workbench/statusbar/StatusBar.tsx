import {
  IStatusBarService,
  StatusBarAlignment,
  ICommandService,
  localize,
} from '@universe-editor/platform'
import type { IPart, IStatusBarEntry } from '@universe-editor/platform'
import { Bell, Loader2, RefreshCw, Shield, Sparkles, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useService, useObservable } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { StatusBarComponentRegistry } from '../../services/statusbar/StatusBarComponentRegistry.js'
import styles from './StatusBar.module.css'

const ICON_MAP: Record<string, LucideIcon> = {
  bell: Bell,
  sparkle: Sparkles,
  shield: Shield,
}

/** Inline `$(codicon)` syntax anywhere in status-bar text (mirrors VSCode). */
const CODICON_RE = /\$\(([a-z0-9-]+)\)/gi

/** Split text into plain-text runs and inline codicon glyphs. */
function renderText(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0
  CODICON_RE.lastIndex = 0
  for (let m = CODICON_RE.exec(text); m; m = CODICON_RE.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    nodes.push(
      <span
        key={m.index}
        className={`codicon codicon-${m[1]} ${styles['text-icon']}`}
        aria-hidden="true"
      />,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Drop `$(codicon)` markers for accessible labels / tooltips. */
function stripCodicons(text: string): string {
  return text.replace(CODICON_RE, '').replace(/\s+/g, ' ').trim()
}

function StatusBarItem({ entry }: { entry: IStatusBarEntry }) {
  const commandService = useService(ICommandService)

  if (entry.componentKey) {
    const Comp = StatusBarComponentRegistry.get(entry.componentKey)
    if (Comp) return <Comp entry={entry} />
  }

  const handleClick = () => {
    if (entry.command) {
      void commandService.executeCommand(entry.command)
    }
  }

  const Icon = entry.icon ? ICON_MAP[entry.icon] : undefined
  const showSpinner = entry.showProgress === true || entry.showProgress === 'spinning'
  const showSyncing = entry.showProgress === 'syncing'
  const label = stripCodicons(entry.text) || entry.tooltip || ''
  const className = [
    styles['item'],
    entry.command ? styles['clickable'] : '',
    entry.kind === 'prominent' ? styles['kind-prominent'] : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button className={className} onClick={handleClick} title={entry.tooltip} aria-label={label}>
      {showSpinner && (
        <Loader2
          size={14}
          strokeWidth={1.75}
          className={styles['spin']}
          aria-hidden="true"
          data-testid="statusbar-spinner"
        />
      )}
      {showSyncing && (
        <RefreshCw
          size={14}
          strokeWidth={1.75}
          className={styles['spin']}
          aria-hidden="true"
          data-testid="statusbar-spinner"
        />
      )}
      {Icon && !showSpinner && !showSyncing && (
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
      )}
      {entry.text && <span>{renderText(entry.text)}</span>}
    </button>
  )
}

export function StatusBar({ part }: { part?: IPart | undefined } = {}) {
  const statusBarService = useService(IStatusBarService)
  const entries = useObservable(statusBarService.entries)
  const containerRef = usePartContainer<HTMLElement>(part)

  const leftEntries = entries
    .filter((e) => e.entry.alignment === StatusBarAlignment.Left)
    .sort((a, b) => b.entry.priority - a.entry.priority)

  const rightEntries = entries
    .filter((e) => e.entry.alignment === StatusBarAlignment.Right)
    .sort((a, b) => b.entry.priority - a.entry.priority)

  return (
    <footer
      ref={containerRef}
      className={styles['statusbar']}
      aria-label={localize('statusbar.label', 'Status Bar')}
      data-testid="part-statusbar"
    >
      <div className={styles['left']}>
        {leftEntries.map((e) => (
          <StatusBarItem key={e.id} entry={e.entry} />
        ))}
      </div>
      <div className={styles['right']}>
        {rightEntries.map((e) => (
          <StatusBarItem key={e.id} entry={e.entry} />
        ))}
      </div>
    </footer>
  )
}
