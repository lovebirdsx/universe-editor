import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { uexConfigPath, readUexConfig, writeUexConfig } from '../lib/configFile.js'

function tempConfigPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'uex-cfg-')), '.uex', 'config.json')
}

describe('uexConfigPath', () => {
  it('lives under <home>/.uex/config.json', () => {
    expect(uexConfigPath('/home/u').replace(/\\/g, '/')).toBe('/home/u/.uex/config.json')
  })
})

describe('readUexConfig', () => {
  it('returns {} when the file is missing', async () => {
    expect(await readUexConfig(tempConfigPath())).toEqual({})
  })

  it('returns {} (and warns) on corrupted JSON', async () => {
    const p = tempConfigPath()
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, '{ not json')
    expect(await readUexConfig(p)).toEqual({})
  })
})

describe('writeUexConfig + readUexConfig round-trip', () => {
  it('persists buckets per registry', async () => {
    const p = tempConfigPath()
    await writeUexConfig(p, {
      defaultRegistry: 'https://market.example.com',
      registries: {
        'https://market.example.com': { token: 'uet_aaa', publisher: 'acme' },
        'https://internal.example.com': { token: 'uet_bbb', publisher: 'acme' },
      },
    })
    const back = await readUexConfig(p)
    expect(back.defaultRegistry).toBe('https://market.example.com')
    expect(back.registries?.['https://internal.example.com']?.publisher).toBe('acme')
  })

  it('creates the .uex directory as needed', async () => {
    const p = tempConfigPath()
    await writeUexConfig(p, {})
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({})
  })
})
