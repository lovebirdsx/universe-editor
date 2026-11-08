import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { loadOrCreateVapidKeys } from '../vapidKeys.js'

const GENERATED = { publicKey: 'public-key-1', privateKey: 'private-key-1' }

describe('loadOrCreateVapidKeys', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkTempDir('ue-mobile-vapid-')
    file = join(dir, 'mobile', 'vapid.json')
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  it('generates and persists a key pair on first use', async () => {
    const generate = (): typeof GENERATED => GENERATED
    const keys = await loadOrCreateVapidKeys(file, { generate })
    expect(keys).toEqual(GENERATED)

    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw).toMatchObject({
      version: 1,
      publicKey: GENERATED.publicKey,
      privateKey: GENERATED.privateKey,
    })
  })

  it.skipIf(process.platform === 'win32')('restricts vapid.json to 0600', async () => {
    await loadOrCreateVapidKeys(file, { generate: () => GENERATED })
    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('reuses the persisted pair without regenerating', async () => {
    await loadOrCreateVapidKeys(file, { generate: () => GENERATED })
    const generate = (): { publicKey: string; privateKey: string } => {
      throw new Error('must not regenerate')
    }
    const keys = await loadOrCreateVapidKeys(file, { generate })
    expect(keys).toEqual(GENERATED)
  })

  it('replaces a corrupt file and reports it', async () => {
    await fs.mkdir(join(dir, 'mobile'), { recursive: true })
    await fs.writeFile(file, '{ not json', 'utf8')
    const corrupt: Error[] = []
    const keys = await loadOrCreateVapidKeys(file, {
      generate: () => GENERATED,
      onCorrupt: (error) => corrupt.push(error),
    })
    expect(keys).toEqual(GENERATED)
    expect(corrupt).toHaveLength(1)
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(raw['version']).toBe(1)
  })

  it('rejects an unsupported file version', async () => {
    await fs.mkdir(join(dir, 'mobile'), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ version: 99, publicKey: 'p', privateKey: 's', createdAt: 1 }),
      'utf8',
    )
    const corrupt: Error[] = []
    await loadOrCreateVapidKeys(file, {
      generate: () => GENERATED,
      onCorrupt: (error) => corrupt.push(error),
    })
    expect(corrupt[0]?.message).toContain('version 99')
  })

  it('refuses an empty generated key pair', async () => {
    await expect(
      loadOrCreateVapidKeys(file, { generate: () => ({ publicKey: '', privateKey: '' }) }),
    ).rejects.toThrow('empty key pair')
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
