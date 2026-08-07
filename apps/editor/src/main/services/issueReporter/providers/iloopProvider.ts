/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  iLoop issue reporter: uploads the diagnostics zip to the go-fastdfs file
 *  server, then builds a pre-filled addPost URL that references the upload as
 *  a post attachment (protocol mirrors scripts/add_post_url.js in the iloop
 *  repo). The post title is deliberately left empty — the user fills it in on
 *  the iLoop page.
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
import { ILoopDefaults, ILoopOptionKeys } from '../../../../shared/issueReporter.js'

interface UploadedFile {
  readonly name: string
  readonly path: string
}

export class ILoopIssueReporterProvider implements IIssueReporterProvider {
  readonly id = 'iloop'
  readonly label = 'iLoop'
  readonly supportsAttachments = true

  constructor(
    private readonly _createDiagnosticsZip: () => Promise<string>,
    private readonly _logger: ILogger,
  ) {}

  async buildIssueUrl(payload: IssueReportPayload): Promise<string> {
    const options = payload.providerOptions ?? {}
    const serverUrl = options[ILoopOptionKeys.serverUrl] || ILoopDefaults.serverUrl
    const appUrl = options[ILoopOptionKeys.appUrl] || ILoopDefaults.appUrl
    const board = options[ILoopOptionKeys.board] || ILoopDefaults.board
    const category = options[ILoopOptionKeys.category] || ILoopDefaults.category

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

  /** Upload one local file to go-fastdfs, returning its server-side path. */
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
