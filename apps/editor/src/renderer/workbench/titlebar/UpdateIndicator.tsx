/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Title-bar update indicator. A horizontal icon + label pill (VSCode-style) that
 *  appears only when there's something to show (checking / available / downloading /
 *  downloaded). The short label makes it far easier to notice than an icon alone; the
 *  actionable states (available / downloaded) render as a prominent accent button.
 *  Clicking dispatches by state — available → download, downloaded → restart, checking
 *  → nothing, otherwise a manual check. While downloading, a thin determinate bar sits
 *  under the label.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState } from 'react'
import { ICommandService, localize } from '@universe-editor/platform'
import { CircleFadingArrowUp, Download, LoaderCircle, PackageCheck } from 'lucide-react'
import { useService } from '../useService.js'
import {
  IUpdateService,
  type UpdateState,
  type UpdateUrgency,
} from '../../../shared/ipc/updateService.js'
import { CheckForUpdatesAction } from '../../actions/updateActions.js'
import styles from './TitleBar.module.css'

type Glyph = 'checking' | 'available' | 'downloading' | 'downloaded'

interface Presentation {
  readonly glyph: Glyph
  /** Short label shown next to the glyph, e.g. "Update", "Checking…". */
  readonly label: string
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
        label: localize('update.checkingLabel', 'Checking…'),
        tooltip: localize('update.checkingShort', 'Checking for updates…'),
        prominent: false,
      }
    case 'available':
      // An important update is downloaded for the user, so by the time this renders
      // there is nothing left to click — show it as the download it is about to be.
      if (state.autoDownload) {
        return {
          glyph: 'downloading',
          label: localize('update.important.downloadingLabel', 'Important update… {percent}%', {
            percent: 0,
          }),
          tooltip: localize(
            'update.important.downloadingTooltip',
            'Downloading an important update… {percent}%',
            { percent: 0 },
          ),
          prominent: false,
          percent: 0,
        }
      }
      return {
        glyph: 'available',
        label: importantLabel(state.urgency) ?? localize('update.availableLabel', 'Update'),
        tooltip:
          state.urgency === 'important'
            ? localize(
                'update.important.statusbar.tooltip',
                'Important update {version} is available — click to download',
                { version: state.version },
              )
            : localize(
                'update.availableTooltip',
                'A new version ({version}) is available — click to download',
                { version: state.version },
              ),
        prominent: true,
      }
    case 'downloading':
      return {
        glyph: 'downloading',
        label:
          state.urgency === 'important'
            ? localize('update.important.downloadingLabel', 'Important update… {percent}%', {
                percent: state.percent,
              })
            : localize('update.downloadingLabel', 'Downloading… {percent}%', {
                percent: state.percent,
              }),
        tooltip:
          state.urgency === 'important'
            ? localize(
                'update.important.downloadingTooltip',
                'Downloading an important update… {percent}%',
                { percent: state.percent },
              )
            : localize('update.downloadingShort', 'Downloading update… {percent}%', {
                percent: state.percent,
              }),
        prominent: false,
        percent: state.percent,
      }
    case 'downloaded':
      return {
        glyph: 'downloaded',
        label:
          importantLabel(state.urgency) ?? localize('update.downloadedLabel', 'Restart to update'),
        tooltip:
          state.urgency === 'important'
            ? localize(
                'update.important.downloadedTooltip',
                'Important update {version} downloaded — click to restart and install',
                { version: state.version },
              )
            : localize(
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

/** Shared short label for the important variants; `undefined` means "not important". */
function importantLabel(urgency: UpdateUrgency | undefined): string | undefined {
  return urgency === 'important'
    ? localize('update.important.label', 'Important update')
    : undefined
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
        // Already downloading itself — a second start would re-enter the failure path.
        if (!state.autoDownload) void update.downloadUpdate()
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
  if (view.glyph === 'available') classNames.push(styles['update-btn--available'])
  else if (view.glyph === 'downloaded') classNames.push(styles['update-btn--downloaded'])

  return (
    <button
      className={classNames.join(' ')}
      onClick={onClick}
      data-tooltip={view.tooltip}
      aria-label={view.tooltip}
      data-testid="titlebar-update-indicator"
    >
      <GlyphIcon glyph={view.glyph} />
      <span className={styles['update-label']}>{view.label}</span>
      {view.percent !== undefined && (
        <span className={styles['update-progress']} aria-hidden>
          <span className={styles['update-progress-fill']} style={{ width: `${view.percent}%` }} />
        </span>
      )}
    </button>
  )
}
