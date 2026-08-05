/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pluggable issue-reporting targets (GitHub / iLoop / ...). A provider turns a
 *  collected diagnostics summary into an issue-page URL, optionally uploading
 *  the diagnostics zip as an attachment first. Providers run in the main
 *  process (network access + filesystem zip); the renderer only picks one and
 *  opens the resulting URL.
 *--------------------------------------------------------------------------------------------*/

export interface IssueReportProviderInfo {
  readonly id: string
  readonly label: string
  /** True when the provider can carry the diagnostics zip along with the report. */
  readonly supportsAttachments: boolean
}

export interface IssueReportPayload {
  /** The diagnostics markdown summary (already copied to the clipboard by the caller). */
  readonly markdown: string
  /**
   * Shorter body used when the fully pre-filled URL would exceed the safe URL
   * length cap — the user pastes the clipboard summary instead.
   */
  readonly pasteHint: string
  /** Ask the provider to upload and attach the diagnostics zip (only honored when supported). */
  readonly attachDiagnostics: boolean
  /**
   * Provider-specific options forwarded verbatim from settings
   * (e.g. iLoop's serverUrl / appUrl / board / category). Populated by the renderer.
   */
  readonly providerOptions?: Readonly<Record<string, string>>
}

export interface IIssueReporterProvider {
  readonly id: string
  readonly label: string
  readonly supportsAttachments: boolean
  /**
   * Produce the issue-page URL to open. When `payload.attachDiagnostics` is
   * true and supported, this is where the upload happens — implementations
   * should throw on upload failure so the caller can offer a fallback.
   */
  buildIssueUrl(payload: IssueReportPayload): Promise<string>
}

/** Above this the URL itself risks truncation in browsers / shells (VSCode uses the same cap). */
export const ISSUE_URL_MAX_LENGTH = 7500
