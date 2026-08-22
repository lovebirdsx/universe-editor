/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import type { AiProviderInstance, AiProviderType } from '@universe-editor/platform'
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

/** The persisted provider instances + user-defined types backing aiSettings.json. */
export async function readAiSettingsProviders(configLocation: IConfigLocationService): Promise<{
  providers: readonly AiProviderInstance[]
  providerTypes: Readonly<Record<string, AiProviderType>>
}> {
  const path = await getAiSettingsPath(configLocation)
  const root = await readAiSettingsRoot(path)
  const providers = Array.isArray(root['providers'])
    ? (root['providers'] as readonly AiProviderInstance[])
    : []
  const providerTypes = asRecord(root['providerTypes']) ?? {}
  return {
    providers,
    providerTypes: providerTypes as Readonly<Record<string, AiProviderType>>,
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
