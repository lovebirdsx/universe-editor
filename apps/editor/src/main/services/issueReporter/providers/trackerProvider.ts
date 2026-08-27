/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tracker issue reporter: uploads the diagnostics zip to the tracker file
 *  server, then builds a pre-filled addPost URL that references the upload as
 *  a post attachment. The post title is deliberately left empty — the user
 *  fills it in on the tracker page.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import {
  ISSUE_URL_MAX_LENGTH,
  localize,
  type IIssueReporterProvider,
  type ILogger,
  type IssueReportPayload,
} from '@universe-editor/platform'
import {
  ISSUE_REPORTER_NOT_CONFIGURED,
  TrackerDefaults,
  TrackerOptionKeys,
} from '../../../../shared/issueReporter.js'

interface UploadedFile {
  readonly name: string
  readonly path: string
}

export class TrackerIssueReporterProvider implements IIssueReporterProvider {
  readonly id = 'tracker'
  readonly label = 'Tracker'
  readonly supportsAttachments = true

  constructor(
    private readonly _createDiagnosticsZip: () => Promise<string>,
    private readonly _logger: ILogger,
  ) {}

  async buildIssueUrl(payload: IssueReportPayload): Promise<string> {
    const options = payload.providerOptions ?? {}
    const serverUrl = options[TrackerOptionKeys.serverUrl] || TrackerDefaults.serverUrl
    const appUrl = options[TrackerOptionKeys.appUrl] || TrackerDefaults.appUrl
    const board = options[TrackerOptionKeys.board] || TrackerDefaults.board
    const category = options[TrackerOptionKeys.category] || TrackerDefaults.category

    // The tracker defaults are empty (see TrackerDefaults): without an appUrl the
    // addPost URL would degrade to a scheme-less relative path that opener.open can't
    // resolve, and an empty serverUrl would make the upload fetch a relative `/upload`
    // (undici throws an opaque "Failed to parse URL"). Fail fast with a clear message.
    if (!appUrl || (payload.attachDiagnostics && !serverUrl)) {
      throw new Error(
        ISSUE_REPORTER_NOT_CONFIGURED +
          localize(
            'issueReporter.error.notConfigured',
            'Issue tracker is not configured. Set issueReporter.tracker.serverUrl and issueReporter.tracker.appUrl.',
          ),
      )
    }

    let attachment: string | undefined
    if (payload.attachDiagnostics) {
      const zipPath = await this._createDiagnosticsZip()
      const uploaded = await this._upload(serverUrl, zipPath)
      // The prefill protocol encodes attachments as `name@path`; a name
      // containing @ or , would break parsing, so fall back to the bare path
      // (the frontend then shows the path's last segment as the name).
      attachment =
        !uploaded.name.includes('@') && !uploaded.name.includes(',')
          ? `${uploaded.name}@${uploaded.path}`
          : uploaded.path
    }

    const withContent = this._buildAddPostUrl(appUrl, board, category, payload.markdown, attachment)
    if (withContent.length <= ISSUE_URL_MAX_LENGTH) return withContent
    return this._buildAddPostUrl(appUrl, board, category, payload.pasteHint, attachment)
  }

  /** Upload one local file to the tracker file server, returning its server-side path. */
  private async _upload(serverUrl: string, localPath: string): Promise<UploadedFile> {
    const buffer = await fs.readFile(localPath)
    const name = basename(localPath)

    const formData = new FormData()
    formData.append('file', new Blob([buffer]), name)
    formData.append('output', 'json')
    formData.append('path', '')
    formData.append('scene', '')

    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/upload`, {
      method: 'POST',
      body: formData,
    })
    if (!response.ok) {
      throw new Error(
        localize(
          'issueReporter.error.uploadHttp',
          'Diagnostics upload failed: HTTP {status} {statusText}',
          {
            status: response.status,
            statusText: response.statusText,
          },
        ),
      )
    }
    const data = (await response.json()) as { path?: string }
    if (!data.path) {
      throw new Error(
        localize(
          'issueReporter.error.uploadNoPath',
          'Diagnostics upload response has no path: {body}',
          {
            body: JSON.stringify(data),
          },
        ),
      )
    }
    this._logger.info(`diagnostics zip uploaded: ${localPath} -> ${data.path}`)
    return { name, path: data.path }
  }

  private _buildAddPostUrl(
    appUrl: string,
    board: string,
    category: string,
    content: string,
    attachment: string | undefined,
  ): string {
    const params = new URLSearchParams()
    params.set('board', board)
    params.set('category', category)
    params.set('content', content)
    if (attachment !== undefined) params.set('attachments', attachment)
    return `${appUrl.replace(/\/$/, '')}/addPost?${params.toString()}`
  }
}
