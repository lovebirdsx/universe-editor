/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionListPanel — what the AGENTS view shows in SecondarySideBar when Chat
 *  lives in the EditorArea. The toolbar (New / choose agent / refresh / switch to
 *  sidebar) lives in the view's title bar (AgentsViewToolbar); this component
 *  just hosts the shared SessionListBody. Picking a row resumes/activates the
 *  session through SessionListBody's built-in click handling.
 *--------------------------------------------------------------------------------------------*/

import { SessionListBody } from './SessionListBody.js'
import styles from './agents.module.css'

export function SessionListPanel() {
  return (
    <div className={styles['sessionList']} data-testid="acp-session-list">
      <SessionListBody scrollStateKey="agentsSessionList" />
    </div>
  )
}
