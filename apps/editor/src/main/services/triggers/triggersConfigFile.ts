/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  On-disk adapters for triggers:
 *   - `<workspace>/.universe-editor/triggers.json` — commit-able trigger definitions
 *     (JSONC read + deterministic serialization + the commented example),
 *   - `<configDir>/settings.json` — the machine-local `triggers.maxConcurrentRuns`
 *     cap, read directly because main has no IConfigurationService.
 *  Parsing itself lives in shared/triggers/configParse.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import {
  parseTriggersConfig,
  parseWorkspaceUri,
  TRIGGERS_CONFIG_EXAMPLE,
} from '../../../shared/triggers/configParse.js'
import {
  TRIGGER_DEFAULTS,
  TRIGGERS_MAX_CONCURRENT_RUNS_KEY,
  TRIGGERS_WORKSPACE_CONFIG_FILE,
  TRIGGERS_WORKSPACE_DIR,
  type TriggersConfig,
} from '../../../shared/triggers/types.js'
import type { JsonConfigReadResult } from '../jsonConfig/jsonConfigFileStore.js'
import { writeFileAtomic } from '../jsonConfig/atomicFile.js'

/** Machine-local trigger data (state, audit, runs, the workspace registry). */
export const TRIGGERS_DIR_NAME = 'triggers'
export const TRIGGERS_CONFIG_FILE_NAME = TRIGGERS_WORKSPACE_CONFIG_FILE

export function triggersDirectory(userDataDir: string): string {
  return join(userDataDir, TRIGGERS_DIR_NAME)
}

/** Trigger definitions live inside the workspace so they can be committed. */
export function workspaceTriggersConfigPath(workspace: string): string {
  return join(workspace, TRIGGERS_WORKSPACE_DIR, TRIGGERS_WORKSPACE_CONFIG_FILE)
}

/** Provider-facing location (remote workspaces have no local path). */
export function workspaceTriggersConfigUri(workspaceUri: URI): URI {
  return URI.joinPath(workspaceUri, TRIGGERS_WORKSPACE_DIR, TRIGGERS_WORKSPACE_CONFIG_FILE)
}

/** Directory the remote watcher prefers; it may not exist yet. */
export function workspaceTriggersConfigDirUri(workspaceUri: URI): URI {
  return URI.joinPath(workspaceUri, TRIGGERS_WORKSPACE_DIR)
}

/**
 * Where the trigger file lives for a workspace identity: a local filesystem path
 * for `file:` workspaces, the provider URI string for remote ones.
 */
export function workspaceTriggersConfigLocation(workspace: string): string {
  const uri = parseWorkspaceUri(workspace)
  if (uri === undefined) return workspaceTriggersConfigPath(workspace)
  if (uri.scheme === REMOTE_SCHEME) return workspaceTriggersConfigUri(uri).toString()
  return workspaceTriggersConfigPath(uri.fsPath)
}

export function createEmptyTriggersConfig(): TriggersConfig {
  return { version: 1, triggers: [], invalid: [] }
}

/** Fixed shape keeps the store's external-edit comparison stable. */
export function serializeTriggersConfig(config: TriggersConfig): unknown {
  return {
    version: config.version,
    triggers: config.triggers.map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      showSession: trigger.showSession,
      source: trigger.source,
      session: {
        ...trigger.session,
        budget: trigger.session.budget,
      },
      allowedActions: [...trigger.allowedActions],
      concurrency: trigger.concurrency,
      overflow: trigger.overflow,
    })),
    invalid: config.invalid.map((entry) => ({ id: entry.id, errors: [...entry.errors] })),
  }
}

export async function readTriggersConfigFile(
  file: string,
): Promise<JsonConfigReadResult<TriggersConfig>> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return {
      kind: 'invalid',
      error: `cannot read ${TRIGGERS_CONFIG_FILE_NAME}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return parseTriggersConfigText(text)
}

/**
 * JSONC parse + validation shared by the local file reader and the remote store,
 * so both surfaces accept exactly the same shape and report the same errors.
 */
export function parseTriggersConfigText(text: string): JsonConfigReadResult<TriggersConfig> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return { kind: 'ok', value: createEmptyTriggersConfig() }

  const errors: ParseError[] = []
  const raw: unknown = parse(body, errors, { allowTrailingComma: true })
  const firstError = errors[0]
  if (firstError !== undefined) {
    return {
      kind: 'invalid',
      error: `${TRIGGERS_CONFIG_FILE_NAME} is not valid JSON (offset ${firstError.offset})`,
    }
  }

  const parsed = parseTriggersConfig(raw)
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error }
  return { kind: 'ok', value: parsed.config }
}

/** Writes the commented example only when the file is absent; never overwrites an edit. */
export async function ensureTriggersConfigFile(file: string): Promise<boolean> {
  try {
    await stat(file)
    return false
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await writeFileAtomic(file, TRIGGERS_CONFIG_EXAMPLE)
  return true
}

/** User-settings key for the machine-wide concurrent run cap. */
export const MAX_CONCURRENT_RUNS_SETTING_KEY = TRIGGERS_MAX_CONCURRENT_RUNS_KEY

/** Clamps a user-provided cap; anything non-integer falls back to the default. */
export function normalizeMaxConcurrentRuns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
    return TRIGGER_DEFAULTS.maxConcurrentRuns
  }
  return value
}

/**
 * Reads `triggers.maxConcurrentRuns` from the active config directory's
 * settings.json. Best effort: a missing / unparsable file or an out-of-range
 * value falls back to the default instead of failing startup.
 */
export async function readMaxConcurrentRunsSetting(configDir: string): Promise<number> {
  let raw: Record<string, unknown> | undefined
  try {
    const text = await readFile(join(configDir, 'settings.json'), 'utf8')
    if (text.trim() !== '') {
      raw = parse(text, [], { allowTrailingComma: true }) as Record<string, unknown> | undefined
    }
  } catch {
    return TRIGGER_DEFAULTS.maxConcurrentRuns
  }
  return normalizeMaxConcurrentRuns(raw?.[MAX_CONCURRENT_RUNS_SETTING_KEY])
}
