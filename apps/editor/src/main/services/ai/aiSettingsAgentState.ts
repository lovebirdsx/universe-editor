/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'

const AI_SETTINGS_FILE = 'aiSettings.json'
const writeQueues = new Map<string, Promise<void>>()

export async function readAiSettingsAgentState<T>(
  configLocation: IConfigLocationService,
  agentId: string,
): Promise<T | undefined> {
  const path = await getAiSettingsPath(configLocation)
  const root = await readRoot(path)
  const agents = asRecord(root['agentSettings'])
  return agents?.[agentId] as T | undefined
}

export async function updateAiSettingsAgentState<T>(
  configLocation: IConfigLocationService,
  agentId: string,
  update: (current: T | undefined) => T,
): Promise<T> {
  const path = await getAiSettingsPath(configLocation)
  const previous = writeQueues.get(path) ?? Promise.resolve()
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const root = await readRoot(path)
      const agents = { ...(asRecord(root['agentSettings']) ?? {}) }
      const next = update(agents[agentId] as T | undefined)
      agents[agentId] = next
      root['agentSettings'] = agents
      await writeRoot(path, root)
      return next
    })
  writeQueues.set(
    path,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  )
  return operation
}

async function getAiSettingsPath(configLocation: IConfigLocationService): Promise<string> {
  const { dir } = await configLocation.getInfo()
  return join(dir, AI_SETTINGS_FILE)
}

async function readRoot(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = parse(raw, [], { allowTrailingComma: true })
    return asRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

async function writeRoot(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
