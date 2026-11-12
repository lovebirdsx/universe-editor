/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persisted `acp.lastSessionCwd` wire shape, shared by the renderer service
 *  that writes it and the main-process reader used by the mobile gateway.
 *--------------------------------------------------------------------------------------------*/

export const ACP_LAST_SESSION_CWD_STORAGE_KEY = 'acp.lastSessionCwd'
export const ACP_LAST_SESSION_CWD_SCHEMA_VERSION = 1

export interface PersistedAcpLastSessionCwd {
  readonly schemaVersion: number
  readonly cwd?: string
  readonly authority?: string
}
