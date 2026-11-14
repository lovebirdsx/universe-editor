/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Machine-local registry of workspaces whose `.universe-editor/triggers.json` the
 *  scheduler keeps watching (`<userData>/triggers/workspaces.json`). A workspace is
 *  registered the first time a window opens it with that file present, and it
 *  keeps running after every window for it closes. Entries are workspace URI
 *  strings (`file:` / `remote-ssh:`). Version 1 files held bare local paths and are
 *  discarded on load — this file is machine-local, re-opening the workspace
 *  registers it again. Never committed.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import type { ILogger } from '@universe-editor/platform'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import { writeJsonAtomic } from '../jsonConfig/atomicFile.js'
import { workspaceComparisonKey } from './triggerIdentity.js'

export const TRIGGERS_WORKSPACES_FILE_NAME = 'workspaces.json'
const FILE_VERSION = 2

interface RegistryFile {
  readonly version: 2
  readonly workspaces: readonly string[]
}

export interface TriggerWorkspaceRegistryOptions {
  readonly file: string
  readonly logger: ILogger
}

export class TriggerWorkspaceRegistry {
  private readonly _file: string
  private readonly _logger: ILogger
  private _workspaces: string[] = []
  private _serial: Promise<void> = Promise.resolve()

  constructor(options: TriggerWorkspaceRegistryOptions) {
    this._file = options.file
    this._logger = options.logger
  }

  get file(): string {
    return this._file
  }

  /** Workspace URI strings, in registration order. */
  list(): readonly string[] {
    return [...this._workspaces]
  }

  async load(): Promise<readonly string[]> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this._file, 'utf8'))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this._logger.warn(
          `${TRIGGERS_WORKSPACES_FILE_NAME} is unreadable; starting empty: ${describeError(err)}`,
        )
      }
      this._workspaces = []
      return this.list()
    }
    this._workspaces = normalizeRegistry(raw, this._logger)
    return this.list()
  }

  /** Idempotent; returns true when the registry changed. */
  register(workspace: string): Promise<boolean> {
    const value = toWorkspaceUriString(workspace)
    if (value === undefined) {
      this._logger.warn(`refusing to register an unsupported workspace uri: ${workspace}`)
      return Promise.resolve(false)
    }
    const key = workspaceComparisonKey(value)
    if (this._workspaces.some((entry) => workspaceComparisonKey(entry) === key)) {
      return Promise.resolve(false)
    }
    this._workspaces = [...this._workspaces, value]
    this._logger.info(`trigger workspace registered: ${value}`)
    return this._write().then(() => true)
  }

  /** Idempotent; returns true when the registry changed. */
  remove(workspace: string): Promise<boolean> {
    const key = workspaceComparisonKey(workspace)
    const next = this._workspaces.filter((entry) => workspaceComparisonKey(entry) !== key)
    if (next.length === this._workspaces.length) return Promise.resolve(false)
    this._workspaces = next
    this._logger.info(`trigger workspace removed: ${workspace}`)
    return this._write().then(() => true)
  }

  private _write(): Promise<void> {
    const value: RegistryFile = { version: FILE_VERSION, workspaces: this._workspaces }
    this._serial = this._serial.then(
      () => writeJsonAtomic(this._file, value),
      () => writeJsonAtomic(this._file, value),
    )
    return this._serial.catch((err: unknown) => {
      this._logger.warn(`cannot write ${TRIGGERS_WORKSPACES_FILE_NAME}: ${describeError(err)}`)
    })
  }
}

function normalizeRegistry(raw: unknown, logger: ILogger): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const file = raw as { version?: unknown; workspaces?: unknown }
  if (file.version !== FILE_VERSION) {
    if (file.version !== undefined) {
      logger.info(
        `${TRIGGERS_WORKSPACES_FILE_NAME} version ${String(file.version)} is obsolete; starting empty`,
      )
    }
    return []
  }
  if (!Array.isArray(file.workspaces)) return []
  const result: string[] = []
  for (const entry of file.workspaces) {
    const value = toWorkspaceUriString(entry)
    if (value === undefined) {
      logger.warn(`dropping an invalid workspace entry from ${TRIGGERS_WORKSPACES_FILE_NAME}`)
      continue
    }
    const key = workspaceComparisonKey(value)
    if (result.some((existing) => workspaceComparisonKey(existing) === key)) continue
    result.push(value)
  }
  return result
}

/** Registered entries are URI strings; a bare path is not a workspace identity here. */
function toWorkspaceUriString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.includes('://')) return undefined
  return parseWorkspaceUri(value)?.toString()
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
