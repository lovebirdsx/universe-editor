/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Generic per-agent state helpers. The provider list itself is read through
 *  IAiModelMainService.getProviders(); this module only owns the opaque
 *  `agentSettings.<agentId>` slice of aiSettings.json.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { mutateAiSettingsFile, readAiSettingsRoot } from './aiSettingsFile.js'

const AI_SETTINGS_FILE = 'aiSettings.json'

export async function readAiSettingsAgentState<T>(
  configLocation: IConfigLocationService,
  agentId: string,
): Promise<T | undefined> {
  const path = await getAiSettingsPath(configLocation)
  const root = await readAiSettingsRoot(path)
  const agents = asRecord(root['agentSettings'])
  return agents?.[agentId] as T | undefined
}

export async function updateAiSettingsAgentState<T>(
  configLocation: IConfigLocationService,
  agentId: string,
  update: (current: T | undefined) => T,
): Promise<T> {
  const path = await getAiSettingsPath(configLocation)
  let next!: T
  await mutateAiSettingsFile(path, (root) => {
    const agents = { ...(asRecord(root['agentSettings']) ?? {}) }
    next = update(agents[agentId] as T | undefined)
    agents[agentId] = next
    root['agentSettings'] = agents
  })
  return next
}

async function getAiSettingsPath(configLocation: IConfigLocationService): Promise<string> {
  const { dir } = await configLocation.getInfo()
  return join(dir, AI_SETTINGS_FILE)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
