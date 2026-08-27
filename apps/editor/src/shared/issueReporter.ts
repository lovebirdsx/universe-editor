/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared constants for the pluggable Report Issue flow: provider ids, the
 *  issueReporter.* settings keys, and the tracker deployment defaults. Kept in
 *  shared/ so the main-side providers, the renderer action flow, and the
 *  settings schema all read the same values.
 *--------------------------------------------------------------------------------------------*/

export const GITHUB_PROVIDER_ID = 'github'
export const TRACKER_PROVIDER_ID = 'tracker'

export const ISSUE_REPORTER_PROVIDER_SETTING_KEY = 'issueReporter.provider'
export const DEFAULT_ISSUE_REPORTER_PROVIDER = TRACKER_PROVIDER_ID

export const TRACKER_SERVER_URL_SETTING_KEY = 'issueReporter.tracker.serverUrl'
export const TRACKER_APP_URL_SETTING_KEY = 'issueReporter.tracker.appUrl'
export const TRACKER_BOARD_SETTING_KEY = 'issueReporter.tracker.board'
export const TRACKER_CATEGORY_SETTING_KEY = 'issueReporter.tracker.category'

/** Keys of the providerOptions record forwarded to the tracker provider over IPC. */
export const TrackerOptionKeys = {
  serverUrl: 'serverUrl',
  appUrl: 'appUrl',
  board: 'board',
  category: 'category',
} as const

/** Defaults for the issueReporter.tracker.* settings (must match the settings schema).
 *  serverUrl / appUrl default to empty: the tracker is only usable once configured
 *  (the report-issue flow surfaces a "not configured" message until then). */
export const TrackerDefaults = {
  serverUrl: '',
  appUrl: '',
  board: 'universe-editor',
  category: 'bug修复',
} as const

/** Marks a "not configured" failure so the renderer can tell it apart from a real
 *  upload error: retrying without the attachment won't help, so that action is
 *  pointless and the "upload failed" wording would be misleading. Travels as a
 *  message prefix because only the message survives the IPC error boundary. */
export const ISSUE_REPORTER_NOT_CONFIGURED = 'issueReporter.notConfigured:'
