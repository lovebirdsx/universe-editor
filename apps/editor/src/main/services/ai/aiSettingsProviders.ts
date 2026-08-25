/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared reader for the aiSettings.json `providers[]`, resolved to runtime form.
 *  Both the Claude and Codex config services reverse-look the agent's live
 *  credential against these entries, so the read+resolve lives here once instead
 *  of twice (the two services must agree on resolution, or the panels disagree).
 *--------------------------------------------------------------------------------------------*/

import { join } from 'node:path'
import {
  resolveProviderEntries,
  type AiProviderEntry,
  type AiResolvedProvider,
} from '@universe-editor/platform'
import { BUILTIN_MODEL_KNOWLEDGE } from '../../../shared/ai/catalog/modelKnowledge.js'
import type { IConfigLocationService } from '../../../shared/ipc/configLocationService.js'
import { readAiSettingsRoot } from './aiSettingsFile.js'

export async function readResolvedProviders(
  configLocation: IConfigLocationService | undefined,
): Promise<readonly AiResolvedProvider[]> {
  if (!configLocation) return []
  const { dir } = await configLocation.getInfo()
  const root = await readAiSettingsRoot(join(dir, 'aiSettings.json'))
  const raw = root['providers']
  const entries: readonly AiProviderEntry[] = Array.isArray(raw) ? raw : []
  return resolveProviderEntries(entries, BUILTIN_MODEL_KNOWLEDGE).providers
}
