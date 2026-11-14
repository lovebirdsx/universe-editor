/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side read / write of a workspace's `.universe-editor/triggers.json`.
 *  Writes go through IFileService (works for local and remote-ssh workspaces) and
 *  apply only the changed fields through the shared JSONC helpers, so comments on
 *  untouched lines survive. mtime is re-checked before every write; the panel
 *  also refuses to write while the JSON tab has unsaved edits.
 *--------------------------------------------------------------------------------------------*/

import {
  FileSystemError,
  URI,
  type IEditorGroupsService,
  type IFileService,
  type IUriIdentityService,
} from '@universe-editor/platform'
import {
  appendTrigger,
  applyTriggerEdits,
  locateTrigger,
  parseTriggerDocument,
  type TriggerConfigEdit,
} from '../../../shared/triggers/configDocument.js'
import { TRIGGERS_CONFIG_HEADER_COMMENT } from '../../../shared/triggers/configParse.js'
import {
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  TRIGGERS_WORKSPACE_DIR,
  type TriggerConfig,
} from '../../../shared/triggers/types.js'
import type { JSONPath } from 'jsonc-parser'
import { findExistingFileEditor } from '../editor/revealEditorPosition.js'

export interface TriggerConfigSnapshot {
  readonly uri: URI
  readonly text: string
  readonly mtime: number
}

export type SaveTriggerConfigResult =
  | { readonly kind: 'ok'; readonly text: string; readonly mtime: number }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'missing-trigger' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'dirty-editor' }

export type CreateTriggerResult = SaveTriggerConfigResult | { readonly kind: 'duplicate-id' }

export interface TriggerConfigWriteOptions {
  /** Re-checked right before the write: the JSON tab may have become dirty meanwhile. */
  readonly isEditorDirty?: () => boolean
}

export interface TriggerConfigEditorAccess {
  readonly groups: IEditorGroupsService
  readonly uriIdentity: IUriIdentityService
}

/** Workspace-relative config file URI; remote workspaces keep their scheme/authority. */
export function triggersConfigUri(workspaceUri: URI): URI {
  return URI.joinPath(workspaceUri, TRIGGERS_WORKSPACE_DIR, TRIGGERS_WORKSPACE_CONFIG_FILE)
}

/**
 * An open JSON tab with unsaved edits would be overwritten by a form write, so
 * both the configuration form and the create wizard refuse to write until it is
 * saved or reverted.
 */
export function isTriggerConfigEditorDirty(
  access: TriggerConfigEditorAccess,
  configUri: URI,
): boolean {
  return (
    findExistingFileEditor(access.groups, access.uriIdentity, configUri)?.editor.isDirty === true
  )
}

function isNotFound(err: unknown): boolean {
  return err instanceof FileSystemError && err.code === 'ENOENT'
}

async function statMtime(files: IFileService, uri: URI): Promise<number | undefined> {
  try {
    return (await files.stat(uri)).mtime
  } catch (err) {
    if (isNotFound(err)) return undefined
    throw err
  }
}

/** `undefined` when the file does not exist yet (first trigger gets created). */
export async function readTriggerConfig(
  files: IFileService,
  workspaceUri: URI,
): Promise<TriggerConfigSnapshot | undefined> {
  const uri = triggersConfigUri(workspaceUri)
  const mtime = await statMtime(files, uri)
  if (mtime === undefined) return undefined
  const text = await files.readFileText(uri)
  return { uri, text, mtime }
}

/** Stable serialization used for "did this nested value change?" comparisons. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(record).sort()) {
      const entry = record[key]
      if (entry !== undefined) parts.push(`${JSON.stringify(key)}:${stable(entry)}`)
    }
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

/**
 * Only the fields the form owns. `source` and `allowedActions` are replaced as a
 * whole (jsonc cannot merge arrays/objects in place), which is why the panel warns
 * that comments inside them are lost. Unknown fields are never touched.
 */
export function buildTriggerConfigEdits(
  base: TriggerConfig,
  next: TriggerConfig,
  path: JSONPath,
): readonly TriggerConfigEdit[] {
  const edits: TriggerConfigEdit[] = []
  const scalar = (key: 'name' | 'enabled' | 'showSession' | 'concurrency' | 'overflow'): void => {
    if (!same(base[key], next[key])) edits.push({ path: [...path, key], value: next[key] })
  }
  scalar('name')
  scalar('enabled')
  scalar('showSession')
  scalar('concurrency')
  scalar('overflow')

  const sessionPath = [...path, 'session']
  const optionalSession = (key: 'agent' | 'mode' | 'model' | 'cwd' | 'skill'): void => {
    if ((base.session[key] ?? null) !== (next.session[key] ?? null)) {
      edits.push({ path: [...sessionPath, key], value: next.session[key] })
    }
  }
  optionalSession('agent')
  optionalSession('mode')
  optionalSession('model')
  optionalSession('cwd')
  optionalSession('skill')
  if (base.session.prompt !== next.session.prompt) {
    edits.push({ path: [...sessionPath, 'prompt'], value: next.session.prompt })
  }

  const budgetPath = [...sessionPath, 'budget']
  const budget: readonly (keyof TriggerConfig['session']['budget'])[] = [
    'maxCostUsd',
    'timeoutMin',
    'approvalTimeoutMin',
  ]
  for (const key of budget) {
    if (base.session.budget[key] !== next.session.budget[key]) {
      edits.push({ path: [...budgetPath, key], value: next.session.budget[key] })
    }
  }

  if (!same(base.source, next.source)) edits.push({ path: [...path, 'source'], value: next.source })
  if (!same(base.allowedActions, next.allowedActions)) {
    edits.push({ path: [...path, 'allowedActions'], value: next.allowedActions })
  }
  return edits
}

function invalidTriggerError(triggerId: string, errors: readonly string[]): string {
  return `"${triggerId}" is invalid: ${errors.join('; ')}`
}

function validateWrite(
  text: string,
  triggerId: string,
): { ok: true } | { ok: false; error: string } {
  const parsed = parseTriggerDocument(text)
  if (parsed.kind !== 'ok') {
    return {
      ok: false,
      error: parsed.kind === 'invalid' ? parsed.error : 'triggers.json is missing',
    }
  }
  const invalid = parsed.value.invalid.find((entry) => entry.id === triggerId)
  if (invalid !== undefined) {
    return { ok: false, error: invalidTriggerError(triggerId, invalid.errors) }
  }
  if (!parsed.value.triggers.some((entry) => entry.id === triggerId)) {
    return { ok: false, error: `trigger "${triggerId}" disappeared from the document` }
  }
  return { ok: true }
}

/**
 * Save one trigger. The caller has already decided to overwrite (dialog); the
 * dirty check is repeated through {@link TriggerConfigWriteOptions} because the
 * JSON tab may have received edits while the confirmation dialog was open.
 */
export async function saveTriggerConfig(
  files: IFileService,
  base: TriggerConfigSnapshot,
  triggerId: string,
  next: TriggerConfig,
  options: TriggerConfigWriteOptions = {},
): Promise<SaveTriggerConfigResult> {
  const mtime = await statMtime(files, base.uri)
  if (mtime === undefined || mtime !== base.mtime) return { kind: 'conflict' }

  const parsed = parseTriggerDocument(base.text)
  if (parsed.kind === 'invalid') return { kind: 'invalid', error: parsed.error }
  if (parsed.kind === 'missing') return { kind: 'missing-trigger' }

  const location = locateTrigger(base.text, triggerId)
  const current = parsed.value.triggers.find((trigger) => trigger.id === triggerId)
  if (location === undefined || current === undefined) {
    const invalid = parsed.value.invalid.find((entry) => entry.id === triggerId)
    if (invalid !== undefined) {
      return { kind: 'invalid', error: invalidTriggerError(triggerId, invalid.errors) }
    }
    return { kind: 'missing-trigger' }
  }

  const edits = buildTriggerConfigEdits(current, next, location.path)
  if (edits.length === 0) return { kind: 'ok', text: base.text, mtime: base.mtime }

  const text = applyTriggerEdits(base.text, edits)
  const validation = validateWrite(text, triggerId)
  if (!validation.ok) return { kind: 'invalid', error: validation.error }

  // Re-check right before writing: another window / process may have saved while
  // we were building edits, and the JSON tab may have become dirty again.
  if (options.isEditorDirty?.() === true) return { kind: 'dirty-editor' }
  const beforeWrite = await statMtime(files, base.uri)
  if (beforeWrite === undefined || beforeWrite !== base.mtime) return { kind: 'conflict' }

  await files.writeFile(base.uri, text)
  const afterWrite = await statMtime(files, base.uri)
  return { kind: 'ok', text, mtime: afterWrite ?? Date.now() }
}

/**
 * Append a new trigger definition. A missing file is created with an empty
 * config (never the example content the "Open Configuration" command writes):
 * `enabled` / confirmation decisions belong to this trigger only.
 */
export async function createTrigger(
  files: IFileService,
  workspaceUri: URI,
  trigger: TriggerConfig,
  options: TriggerConfigWriteOptions = {},
): Promise<CreateTriggerResult> {
  if (options.isEditorDirty?.() === true) return { kind: 'dirty-editor' }
  const existing = await readTriggerConfig(files, workspaceUri)
  let text: string
  if (existing === undefined) {
    const directory = URI.joinPath(workspaceUri, TRIGGERS_WORKSPACE_DIR)
    await files.createDirectory(directory)
    const empty = `${TRIGGERS_CONFIG_HEADER_COMMENT}\n{\n  "version": 1,\n  "triggers": []\n}\n`
    text = appendTrigger(empty, trigger)
  } else {
    const parsed = parseTriggerDocument(existing.text)
    if (parsed.kind === 'invalid') return { kind: 'invalid', error: parsed.error }
    if (parsed.kind === 'missing') {
      return { kind: 'invalid', error: 'triggers.json could not be read' }
    }
    if (
      parsed.value.triggers.some((entry) => entry.id === trigger.id) ||
      parsed.value.invalid.some((entry) => entry.id === trigger.id)
    ) {
      return { kind: 'duplicate-id' }
    }
    const beforeWrite = await statMtime(files, existing.uri)
    if (beforeWrite === undefined || beforeWrite !== existing.mtime) {
      return { kind: 'conflict' }
    }
    text = appendTrigger(existing.text, trigger)
  }

  const validation = validateWrite(text, trigger.id)
  if (!validation.ok) return { kind: 'invalid', error: validation.error }

  const uri = triggersConfigUri(workspaceUri)
  await files.writeFile(uri, text)
  const mtime = await statMtime(files, uri)
  return { kind: 'ok', text, mtime: mtime ?? Date.now() }
}
