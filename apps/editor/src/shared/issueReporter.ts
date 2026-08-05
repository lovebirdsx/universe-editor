/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared constants for the pluggable Report Issue flow: provider ids, the
 *  issueReporter.* settings keys, and the iLoop deployment defaults. Kept in
 *  shared/ so the main-side providers, the renderer action flow, and the
 *  settings schema all read the same values.
 *--------------------------------------------------------------------------------------------*/

export const GITHUB_PROVIDER_ID = 'github'
export const ILOOP_PROVIDER_ID = 'iloop'

export const ISSUE_REPORTER_PROVIDER_SETTING_KEY = 'issueReporter.provider'
export const DEFAULT_ISSUE_REPORTER_PROVIDER = ILOOP_PROVIDER_ID

export const ILOOP_SERVER_URL_SETTING_KEY = 'issueReporter.iloop.serverUrl'
export const ILOOP_APP_URL_SETTING_KEY = 'issueReporter.iloop.appUrl'
export const ILOOP_BOARD_SETTING_KEY = 'issueReporter.iloop.board'
export const ILOOP_CATEGORY_SETTING_KEY = 'issueReporter.iloop.category'

/** Keys of the providerOptions record forwarded to the iLoop provider over IPC. */
export const ILoopOptionKeys = {
  serverUrl: 'serverUrl',
  appUrl: 'appUrl',
  board: 'board',
  category: 'category',
} as const

/** Defaults for the issueReporter.iloop.* settings (must match the settings schema). */
export const ILoopDefaults = {
  serverUrl: 'http://iloop.aki.kuro.com:3030',
  appUrl: 'http://iloop.aki.kuro.com',
  board: 'universe-editor',
  category: 'bug修复',
} as const
