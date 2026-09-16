/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListPanel — the Sessions view body: the list of this window's sessions.
 *  The toolbar (search / filter / New / choose agent / refresh) lives in the
 *  view's title bar (SessionsViewToolbar); this component just hosts the shared
 *  SessionListBody. Picking a row resumes/activates the session through
 *  SessionListBody's built-in click handling.
 *--------------------------------------------------------------------------------------------*/

import { SessionListBody } from './SessionListBody.js'
import styles from './agents.module.css'

export const SESSIONS_VIEW_ID = 'workbench.view.sessions.main'

export function SessionListPanel() {
  return (
    <div className={styles['sessionList']} data-testid="acp-session-list">
      <SessionListBody scrollStateKey="sessionsList" viewId={SESSIONS_VIEW_ID} />
    </div>
  )
}
