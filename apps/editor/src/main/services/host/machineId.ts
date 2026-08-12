/*---------------------------------------------------------------------------------------------
 *  Machine id for `env.machineId`: a random UUID generated once and persisted at
 *  `<userData>/machineid` (the same scheme VSCode uses). It is anonymous (no
 *  hardware fingerprinting) and stable across restarts and updates.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MACHINE_ID_FILE = 'machineid'

let cached: string | undefined

export async function getMachineId(userDataDir: string): Promise<string> {
  if (cached) return cached
  try {
    const existing = (await readFile(join(userDataDir, MACHINE_ID_FILE), 'utf8')).trim()
    if (existing) {
      cached = existing
      return existing
    }
  } catch {
    // Missing or unreadable file falls through to (re)generation.
  }
  const id = randomUUID()
  try {
    await writeFile(join(userDataDir, MACHINE_ID_FILE), id, 'utf8')
  } catch {
    // Persistence best-effort: the id still works for this session.
  }
  cached = id
  return id
}

export function _resetForTests(): void {
  cached = undefined
}
