/**
 * `~/.uex/config.json` — uex's persistent state (registry URL + publish
 * tokens), written by `uex login`. Tokens are stored in plain text (same as
 * `~/.vsce`); the README carries the warning and CI should prefer
 * UNIVERSE_MARKET_TOKEN.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { warn } from '../output.js'

export interface RegistryBucket {
  token?: string | undefined
  publisher?: string | undefined
}

export interface UexConfigFile {
  defaultRegistry?: string | undefined
  /** Per-registry credentials, keyed by normalized registry URL. */
  registries?: Record<string, RegistryBucket> | undefined
}

export function uexConfigPath(homeDir: string): string {
  return path.join(homeDir, '.uex', 'config.json')
}

export async function readUexConfig(configPath: string): Promise<UexConfigFile> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as UexConfigFile
  } catch {
    warn(`could not parse ${configPath} — starting from an empty config`)
    return {}
  }
}

export async function writeUexConfig(configPath: string, config: UexConfigFile): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}
