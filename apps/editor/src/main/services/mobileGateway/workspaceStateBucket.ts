/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-only parser for a workspace's persisted storage bucket
 *  (`<userData>/workspaces/<sha1(folderUri)[0:16]>.json`).
 *
 *  Main only needs a few keys (session history, last session cwd) for closed
 *  workspaces, so it reads the bucket directly instead of asking a renderer.
 *  Corrupt or oversized files are reported, never rewritten.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import { URI, type ILogger } from '@universe-editor/platform'
import { workspaceIdFromUri, workspaceStoragePathFor } from '../../storage.js'

export const DEFAULT_WORKSPACE_STATE_BUCKET_MAX_BYTES = 16 * 1024 * 1024

export type WorkspaceStateBucketReadReason =
  | 'invalid-folder'
  | 'unavailable'
  | 'too-large'
  | 'invalid-json'
  | 'not-object'

export type WorkspaceStateBucketReadResult =
  | { readonly ok: true; readonly state: Record<string, unknown> }
  | { readonly ok: false; readonly reason: WorkspaceStateBucketReadReason }

export interface WorkspaceStateBucketReadOptions {
  readonly userDataDir: string
  /** Workspace folder URI string, exactly the form used for the storage bucket. */
  readonly folder: string
  readonly maxBytes: number
  /** Log prefix; the folder path itself is never logged. */
  readonly label: string
  readonly logger?: Pick<ILogger, 'debug'>
}

export async function readWorkspaceStateBucket(
  options: WorkspaceStateBucketReadOptions,
): Promise<WorkspaceStateBucketReadResult> {
  try {
    URI.parse(options.folder)
  } catch {
    options.logger?.debug(`${options.label} skipped: invalid folder URI`)
    return { ok: false, reason: 'invalid-folder' }
  }

  const file = workspaceStoragePathFor(options.userDataDir, workspaceIdFromUri(options.folder))
  let text: string
  try {
    const info = await stat(file)
    if (info.size > options.maxBytes) {
      options.logger?.debug(
        `${options.label} skipped: file is ${info.size} bytes (cap ${options.maxBytes})`,
      )
      return { ok: false, reason: 'too-large' }
    }
    text = await readFile(file, 'utf8')
  } catch (err) {
    options.logger?.debug(`${options.label} unavailable: ${describeBucketReadError(err)}`)
    return { ok: false, reason: 'unavailable' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch {
    options.logger?.debug(`${options.label} is not valid JSON; keeping it untouched`)
    return { ok: false, reason: 'invalid-json' }
  }
  if (!isRecord(parsed)) {
    options.logger?.debug(`${options.label} is not a JSON object; keeping it untouched`)
    return { ok: false, reason: 'not-object' }
  }
  return { ok: true, state: parsed }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeBucketReadError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return `code=${code}`
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) return `name=${name}`
  }
  return 'unknown error'
}
