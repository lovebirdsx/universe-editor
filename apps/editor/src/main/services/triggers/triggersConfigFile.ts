/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  On-disk adapter for `<userData>/triggers/triggers.json`: JSONC read, deterministic
 *  serialization for the JsonConfigFileStore change check, and the commented example
 *  used by "Triggers: Open Config". Parsing itself lives in shared/triggers/configParse.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import {
  parseTriggersConfig,
  TRIGGERS_CONFIG_EXAMPLE,
} from '../../../shared/triggers/configParse.js'
import { TRIGGER_DEFAULTS, type TriggersConfig } from '../../../shared/triggers/types.js'
import type { JsonConfigReadResult } from '../jsonConfig/jsonConfigFileStore.js'
import { writeFileAtomic } from '../jsonConfig/atomicFile.js'

export const TRIGGERS_DIR_NAME = 'triggers'
export const TRIGGERS_CONFIG_FILE_NAME = 'triggers.json'

export function triggersDirectory(userDataDir: string): string {
  return join(userDataDir, TRIGGERS_DIR_NAME)
}

export function triggersConfigPath(userDataDir: string): string {
  return join(triggersDirectory(userDataDir), TRIGGERS_CONFIG_FILE_NAME)
}

export function createEmptyTriggersConfig(): TriggersConfig {
  return {
    version: 1,
    maxConcurrentRuns: TRIGGER_DEFAULTS.maxConcurrentRuns,
    triggers: [],
    invalid: [],
  }
}

/** Fixed shape keeps the store's external-edit comparison stable. */
export function serializeTriggersConfig(config: TriggersConfig): unknown {
  return {
    version: config.version,
    maxConcurrentRuns: config.maxConcurrentRuns,
    triggers: config.triggers.map((trigger) => ({
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      workspace: trigger.workspace,
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
  if (text.trim() === '') return { kind: 'ok', value: createEmptyTriggersConfig() }

  const errors: ParseError[] = []
  const raw: unknown = parse(text, errors, { allowTrailingComma: true })
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
