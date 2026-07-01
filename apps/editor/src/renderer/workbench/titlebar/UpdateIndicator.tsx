/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Title-bar update indicator. A single icon-only button that matches the adjacent
 *  layout controls: it appears only when there's something to show (checking /
 *  available / downloading / downloaded), uses a distinct update glyph (not the AI
 *  sparkle), and carries a native tooltip. Clicking dispatches by state — available
 *  → download, downloaded → restart, checking → nothing, otherwise a manual check.
 *  While downloading, a thin determinate bar sits under the icon.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { ICommandService, localize } from '@universe-editor/platform'
import { CircleFadingArrowUp, Download, LoaderCircle, PackageCheck } from 'lucide-react'
import { useService } from '../useService.js'
import { IUpdateService, type UpdateState } from '../../../shared/ipc/updateService.js'
import { CheckForUpdatesAction } from '../../actions/updateActions.js'
import styles from './TitleBar.module.css'

type Glyph = 'checking' | 'available' | 'downloading' | 'downloaded'

interface Presentation {
  readonly glyph: Glyph
  readonly tooltip: string
  readonly prominent: boolean
  readonly percent?: number
}

function useUpdateState(): UpdateState | undefined {
  const update = useService(IUpdateService)
  const [state, setState] = useState<UpdateState>()
  useEffect(() => {
    let alive = true
    void update.getState().then((s) => {
      if (alive) setState(s)
    })
    const sub = update.onDidChangeState((s) => setState(s))
    return () => {
      alive = false
      sub.dispose()
    }
  }, [update])
  return state
}

export function present(state: UpdateState): Presentation | undefined {
  switch (state.type) {
    case 'checking':
      return {
        glyph: 'checking',
        tooltip: localize('update.checkingShort', 'Checking for updates…'),
        prominent: false,
      }
    case 'available':
      return {
        glyph: 'available',
        tooltip: localize(
          'update.availableTooltip',
          'A new version ({version}) is available — click to download',
          { version: state.version },
        ),
        prominent: true,
      }
    case 'downloading':
      return {
        glyph: 'downloading',
        tooltip: localize('update.downloadingShort', 'Downloading update… {percent}%', {
          percent: state.percent,
        }),
        prominent: false,
        percent: state.percent,
      }
    case 'downloaded':
      return {
        glyph: 'downloaded',
        tooltip: localize(
          'update.downloadedTooltip',
          'Version {version} downloaded — click to restart and install',
          { version: state.version },
        ),
        prominent: true,
      }
    default:
      return undefined
  }
}

function GlyphIcon({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case 'checking':
      return (
        <LoaderCircle size={15} strokeWidth={1.75} className={styles['update-spin']} aria-hidden />
      )
    case 'available':
      return <CircleFadingArrowUp size={15} strokeWidth={1.75} aria-hidden />
    case 'downloading':
      return <Download size={15} strokeWidth={1.75} aria-hidden />
    case 'downloaded':
      return <PackageCheck size={15} strokeWidth={1.75} aria-hidden />
  }
}

export function UpdateIndicator() {
  const update = useService(IUpdateService)
  const commands = useService(ICommandService)
  const state = useUpdateState()

  const onClick = useCallback(() => {
    if (!state) return
    switch (state.type) {
      case 'available':
        void update.downloadUpdate()
        return
      case 'downloaded':
        void update.quitAndInstall()
        return
      case 'checking':
      case 'downloading':
        return
      default:
        void commands.executeCommand(CheckForUpdatesAction.ID)
    }
  }, [state, update, commands])

  if (!state) return null
  const view = present(state)
  if (!view) return null

  const classNames = [styles['update-btn']]
  if (view.prominent) classNames.push(styles['update-btn--prominent'])

  return (
    <button
      className={classNames.join(' ')}
      onClick={onClick}
      title={view.tooltip}
      aria-label={view.tooltip}
      data-testid="titlebar-update-indicator"
    >
      <GlyphIcon glyph={view.glyph} />
      {view.percent !== undefined && (
        <span className={styles['update-progress']} aria-hidden>
          <span className={styles['update-progress-fill']} style={{ width: `${view.percent}%` }} />
        </span>
      )}
    </button>
  )
}
