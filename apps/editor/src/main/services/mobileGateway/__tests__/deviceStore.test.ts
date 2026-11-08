import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { DeviceStore } from '../deviceStore.js'

function sha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url')
}

describe('DeviceStore', () => {
  let dir: string
  let store: DeviceStore

  beforeEach(() => {
    dir = mkTempDir('ue-mobile-gateway-')
    store = new DeviceStore(join(dir, 'mobile', 'devices.json'), { now: () => 1_700_000_000_000 })
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  it('mints a token, stores only its hash, and verifies it', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    expect(added.device.name).toBe('Pixel')
    expect(added.device.platform).toBe('android')
    expect(added.device.createdAt).toBe(1_700_000_000_000)
    expect(added.device.lastSeenAt).toBe(1_700_000_000_000)
    expect(added.token).toHaveLength(43)

    const verified = await store.verify(added.token)
    expect(verified?.deviceId).toBe(added.device.deviceId)

    const raw = await fs.readFile(join(dir, 'mobile', 'devices.json'), 'utf8')
    expect(raw).not.toContain(added.token)
    expect(added.device.tokenHash).toBe(sha256(added.token))
    expect(added.device).not.toHaveProperty('salt')
  })

  it('rejects wrong and empty tokens', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    expect(await store.verify('not-a-token')).toBeUndefined()
    expect(await store.verify('')).toBeUndefined()
    expect(await store.verify(`${added.token}x`)).toBeUndefined()
  })

  it('touches lastSeenAt and persists it', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    await store.touch(added.device.deviceId, 1_700_000_100_000)
    const listed = await store.list()
    expect(listed[0]?.lastSeenAt).toBe(1_700_000_100_000)
  })

  it('revokes a device so its token stops working', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    expect(await store.revoke(added.device.deviceId)).toBe(true)
    expect(await store.verify(added.token)).toBeUndefined()
    expect(await store.list()).toEqual([])
    expect(await store.revoke(added.device.deviceId)).toBe(false)
  })

  it('tolerates a corrupt devices.json', async () => {
    await fs.mkdir(join(dir, 'mobile'), { recursive: true })
    const file = join(dir, 'mobile', 'devices.json')
    await fs.writeFile(file, '{ not json', 'utf8')

    const corrupt: Error[] = []
    const tolerant = new DeviceStore(file, { onCorrupt: (error) => corrupt.push(error) })
    expect(await tolerant.list()).toEqual([])
    expect(corrupt).toHaveLength(1)

    const added = await tolerant.add({ name: 'Pixel', platform: 'android' })
    expect(await tolerant.verify(added.token)).toBeDefined()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 2 })
  })

  it('discards a v1 (scrypt + salt) file and reports corruption', async () => {
    await fs.mkdir(join(dir, 'mobile'), { recursive: true })
    const file = join(dir, 'mobile', 'devices.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        devices: [
          {
            deviceId: 'old-device',
            name: 'Old phone',
            platform: 'ios',
            tokenHash: 'scrypt-digest',
            salt: 'old-salt',
            createdAt: 1,
            lastSeenAt: 1,
          },
        ],
      }),
      'utf8',
    )

    const corrupt: Error[] = []
    const upgraded = new DeviceStore(file, { onCorrupt: (error) => corrupt.push(error) })
    expect(await upgraded.list()).toEqual([])
    expect(corrupt).toHaveLength(1)
    expect(corrupt[0]?.message).toContain('version 1')

    const added = await upgraded.add({ name: 'Pixel', platform: 'android' })
    expect(await upgraded.verify(added.token)).toBeDefined()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ version: 2 })
  })

  it.skipIf(process.platform === 'win32')('writes devices.json with mode 0600', async () => {
    await store.add({ name: 'Pixel', platform: 'android' })
    const stat = await fs.stat(join(dir, 'mobile', 'devices.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })
})
