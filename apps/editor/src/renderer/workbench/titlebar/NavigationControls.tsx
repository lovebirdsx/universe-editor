/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Title-bar back/forward buttons (VSCode's workbench.navigationControl).
 *  Enabled state follows IHistoryService; clicks dispatch the same commands as
 *  Alt+Left / Alt+Right.
 *--------------------------------------------------------------------------------------------*/

import { ArrowLeft, ArrowRight } from 'lucide-react'
import { ICommandService, IHistoryService, localize } from '@universe-editor/platform'
import { useEventValue, useService } from '../useService.js'
import { GoBackAction, GoForwardAction } from '../../actions/historyActions.js'
import styles from './TitleBar.module.css'

export function NavigationControls() {
  const history = useService(IHistoryService)
  const commandService = useService(ICommandService)

  const canGoBack = useEventValue(history.onDidChange, () => history.canGoBack())
  const canGoForward = useEventValue(history.onDidChange, () => history.canGoForward())

  return (
    <div className={styles['navigation-controls']}>
      <button
        className={styles['layout-btn']}
        disabled={!canGoBack}
        onClick={() => void commandService.executeCommand(GoBackAction.ID)}
        title={localize('navigationControls.goBackWithKey', 'Go Back (Alt+LeftArrow)')}
        aria-label={localize('action.goBack.title', 'Go Back')}
        data-testid="titlebar-nav-back"
      >
        <ArrowLeft size={14} strokeWidth={1.75} />
      </button>
      <button
        className={styles['layout-btn']}
        disabled={!canGoForward}
        onClick={() => void commandService.executeCommand(GoForwardAction.ID)}
        title={localize('navigationControls.goForwardWithKey', 'Go Forward (Alt+RightArrow)')}
        aria-label={localize('action.goForward.title', 'Go Forward')}
        data-testid="titlebar-nav-forward"
      >
        <ArrowRight size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
