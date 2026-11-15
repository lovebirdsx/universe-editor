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

export type SaveTriggerConfigRebasedResult =
  | SaveTriggerConfigResult
  | { readonly kind: 'field-conflict'; readonly fields: readonly string[] }

export interface TriggerConfigRebaseOptions extends TriggerConfigWriteOptions {
  /** The config the user's draft started from, used for the three-way merge. */
  readonly origin: TriggerConfig
  /** Apply the local value even when the same field also changed on disk. */
  readonly overwrite?: boolean
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

/**
 * Writes from this window are serialized per file: two panels (or a panel and the
 * wizard) can start from the same snapshot, and without a queue the second
 * stat/read/write would race the first and silently resurrect stale content.
 */
const writeChains = new Map<string, Promise<void>>()

function serializeConfigWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  writeChains.set(key, tail)
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key)
  })
  return run
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

/**
 * mtime alone is not proof the file is unchanged (coarse timestamps, restored
 * backups); compare the actual text as well. Both checks run inside the
 * per-file queue, immediately before the write.
 */
async function changedSinceSnapshot(
  files: IFileService,
  base: TriggerConfigSnapshot,
): Promise<boolean> {
  const mtime = await statMtime(files, base.uri)
  if (mtime === undefined || mtime !== base.mtime) return true
  const current = await files.readFileText(base.uri)
  return current !== base.text
}

function temporaryWriteUri(uri: URI): URI {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return uri.with({ path: `${uri.path}.tmp-${suffix}` })
}

/**
 * Replace the file atomically when the provider supports rename. A direct
 * writeFile would leave a truncated triggers.json if the process dies mid-write,
 * and the scheduler treats invalid JSON as "no triggers".
 */
async function writeConfigAtomically(files: IFileService, uri: URI, text: string): Promise<void> {
  const temp = temporaryWriteUri(uri)
  try {
    await files.writeFile(temp, text)
    await files.rename(temp, uri, { overwrite: true })
  } catch (err) {
    try {
      await files.delete(temp)
    } catch {
      // The temp file was never created or the provider already removed it.
    }
    if (isNotFound(err)) throw err
    // Some providers cannot replace an existing target with rename; fall back to
    // a direct write rather than failing a save the user already confirmed.
    await files.writeFile(uri, text)
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

async function readSnapshotAt(
  files: IFileService,
  uri: URI,
): Promise<TriggerConfigSnapshot | undefined> {
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
 * Only the fields the form owns. `source` is replaced as a whole (jsonc cannot
 * merge objects in place), which is why the panel warns that comments inside it
 * are lost. Unknown fields are never touched.
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
 * Writes for the same config file are serialized, and the snapshot is re-checked
 * (mtime + text) immediately before the atomic replacement.
 */
export async function saveTriggerConfig(
  files: IFileService,
  base: TriggerConfigSnapshot,
  triggerId: string,
  next: TriggerConfig,
  options: TriggerConfigWriteOptions = {},
): Promise<SaveTriggerConfigResult> {
  return serializeConfigWrite(base.uri.toString(), async () => {
    if (await changedSinceSnapshot(files, base)) return { kind: 'conflict' }

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
    if (await changedSinceSnapshot(files, base)) return { kind: 'conflict' }

    await writeConfigAtomically(files, base.uri, text)
    const afterWrite = await statMtime(files, base.uri)
    return { kind: 'ok', text, mtime: afterWrite ?? Date.now() }
  })
}

function valueAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let current = root
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string | number, unknown>)[segment]
  }
  return current
}

/**
 * Save a draft whose snapshot may be stale (the user chose "Keep my edits" after
 * an external change). The latest disk text becomes the base; only fields the
 * user changed relative to the draft origin are applied on top, so unrelated
 * external edits and other triggers survive. A field changed both locally and on
 * disk is reported unless the caller explicitly asks to overwrite it.
 */
export async function saveTriggerConfigRebased(
  files: IFileService,
  base: TriggerConfigSnapshot,
  triggerId: string,
  next: TriggerConfig,
  options: TriggerConfigRebaseOptions,
): Promise<SaveTriggerConfigRebasedResult> {
  return serializeConfigWrite(base.uri.toString(), async () => {
    if (options.isEditorDirty?.() === true) return { kind: 'dirty-editor' }

    const latest = await readSnapshotAt(files, base.uri)
    if (latest === undefined) return { kind: 'missing-trigger' }
    const parsed = parseTriggerDocument(latest.text)
    if (parsed.kind === 'invalid') return { kind: 'invalid', error: parsed.error }
    if (parsed.kind === 'missing') return { kind: 'missing-trigger' }

    const location = locateTrigger(latest.text, triggerId)
    const current = parsed.value.triggers.find((trigger) => trigger.id === triggerId)
    if (location === undefined || current === undefined) {
      const invalid = parsed.value.invalid.find((entry) => entry.id === triggerId)
      if (invalid !== undefined) {
        return { kind: 'invalid', error: invalidTriggerError(triggerId, invalid.errors) }
      }
      return { kind: 'missing-trigger' }
    }

    const userEdits = buildTriggerConfigEdits(options.origin, next, location.path)
    const conflicts: string[] = []
    const edits: TriggerConfigEdit[] = []
    for (const edit of userEdits) {
      const relative = edit.path.slice(location.path.length)
      const diskValue = valueAtPath(current, relative)
      if (same(diskValue, edit.value)) continue
      const originValue = valueAtPath(options.origin, relative)
      if (!same(diskValue, originValue)) {
        conflicts.push(relative.join('.'))
        if (options.overwrite !== true) continue
      }
      edits.push(edit)
    }
    if (conflicts.length > 0 && options.overwrite !== true) {
      return { kind: 'field-conflict', fields: conflicts }
    }
    if (edits.length === 0) return { kind: 'ok', text: latest.text, mtime: latest.mtime }

    const text = applyTriggerEdits(latest.text, edits)
    const validation = validateWrite(text, triggerId)
    if (!validation.ok) return { kind: 'invalid', error: validation.error }

    if (options.isEditorDirty?.() === true) return { kind: 'dirty-editor' }
    // Guard the read-modify-write against another process saving after we read.
    const recheck = await readSnapshotAt(files, base.uri)
    if (recheck === undefined || recheck.mtime !== latest.mtime || recheck.text !== latest.text) {
      return { kind: 'conflict' }
    }

    await writeConfigAtomically(files, base.uri, text)
    const afterWrite = await statMtime(files, base.uri)
    return { kind: 'ok', text, mtime: afterWrite ?? Date.now() }
  })
}

/**
 * config (never the example content the "Open Configuration" command writes):
 * `enabled` / confirmation decisions belong to this trigger only. The whole
 * read-modify-write runs inside the per-file queue, so two windows cannot append
 * one definition on top of the other's snapshot.
 */
export async function createTrigger(
  files: IFileService,
  workspaceUri: URI,
  trigger: TriggerConfig,
  options: TriggerConfigWriteOptions = {},
): Promise<CreateTriggerResult> {
  const uri = triggersConfigUri(workspaceUri)
  return serializeConfigWrite(uri.toString(), async () => {
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
      text = appendTrigger(existing.text, trigger)
    }

    const validation = validateWrite(text, trigger.id)
    if (!validation.ok) return { kind: 'invalid', error: validation.error }

    if (existing !== undefined) {
      if (await changedSinceSnapshot(files, existing)) return { kind: 'conflict' }
    } else if ((await statMtime(files, uri)) !== undefined) {
      // Another window created triggers.json after our read; append to its file
      // on the next attempt instead of overwriting it.
      return { kind: 'conflict' }
    }

    await writeConfigAtomically(files, uri, text)
    const mtime = await statMtime(files, uri)
    return { kind: 'ok', text, mtime: mtime ?? Date.now() }
  })
}
