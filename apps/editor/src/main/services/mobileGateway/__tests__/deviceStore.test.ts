import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { DeviceLimitError, DeviceStore, MAX_PAIRED_DEVICES } from '../deviceStore.js'

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

  it('loads a v2 file that still carries the removed trusted field', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    const file = join(dir, 'mobile', 'devices.json')
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as {
      version: number
      devices: Array<Record<string, unknown>>
    }
    parsed.devices[0]!['trusted'] = true
    await fs.writeFile(file, JSON.stringify(parsed), 'utf8')

    const listed = await store.list()
    expect(listed[0]?.deviceId).toBe(added.device.deviceId)
  })

  it('caps the number of paired devices', async () => {
    for (let index = 0; index < MAX_PAIRED_DEVICES; index += 1) {
      await store.add({ name: `Phone ${index}`, platform: 'other' })
    }
    await expect(store.add({ name: 'One too many', platform: 'other' })).rejects.toBeInstanceOf(
      DeviceLimitError,
    )
    expect(await store.list()).toHaveLength(MAX_PAIRED_DEVICES)
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

  it('stores notification preferences and lists only enabled devices', async () => {
    const first = await store.add({ name: 'Pixel', platform: 'android' })
    const second = await store.add({ name: 'iPhone', platform: 'ios' })

    expect(
      await store.setNotificationPrefs(first.device.deviceId, {
        enabled: true,
        kinds: ['permission', 'question'],
        alwaysNotify: true,
      }),
    ).toBe(true)
    expect(
      await store.setNotificationPrefs(second.device.deviceId, {
        enabled: false,
        alwaysNotify: false,
      }),
    ).toBe(true)
    // Unknown device id changes nothing.
    expect(
      await store.setNotificationPrefs('missing', { enabled: true, alwaysNotify: false }),
    ).toBe(false)

    const listed = await store.get(first.device.deviceId)
    expect(listed?.notifications).toEqual({
      enabled: true,
      kinds: ['permission', 'question'],
      alwaysNotify: true,
    })

    const targets = await store.listNotifyTargets()
    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      deviceId: first.device.deviceId,
      notifications: { enabled: true, alwaysNotify: true },
    })
  })

  it('stores and removes a push subscription', async () => {
    const added = await store.add({ name: 'Pixel', platform: 'android' })
    const deviceId = added.device.deviceId
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    }

    expect(await store.setPushSubscription(deviceId, subscription)).toBe(true)
    await store.setNotificationPrefs(deviceId, { enabled: true, alwaysNotify: false })
    const stored = await store.get(deviceId)
    expect(stored?.push).toEqual({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      updatedAt: 1_700_000_000_000,
    })

    const targets = await store.listNotifyTargets()
    expect(targets[0]?.push?.endpoint).toBe(subscription.endpoint)

    expect(await store.removePushSubscription(deviceId)).toBe(true)
    expect((await store.get(deviceId))?.push).toBeUndefined()
    expect(await store.removePushSubscription(deviceId)).toBe(false)
    expect(await store.removePushSubscription('missing')).toBe(false)
  })

  it('drops malformed notification and push records on load', async () => {
    await fs.mkdir(join(dir, 'mobile'), { recursive: true })
    const file = join(dir, 'mobile', 'devices.json')
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 2,
        devices: [
          {
            deviceId: 'bad',
            name: 'Bad',
            platform: 'ios',
            tokenHash: 'hash',
            createdAt: 1,
            lastSeenAt: 1,
            notifications: { enabled: 'yes' },
          },
          {
            deviceId: 'good',
            name: 'Good',
            platform: 'ios',
            tokenHash: 'hash',
            createdAt: 1,
            lastSeenAt: 1,
            notifications: { enabled: true, alwaysNotify: false },
            push: {
              endpoint: 'https://fcm.googleapis.com/x',
              keys: { p256dh: 'p', auth: 'a' },
              updatedAt: 1,
            },
          },
        ],
      }),
      'utf8',
    )

    const tolerant = new DeviceStore(file)
    const listed = await tolerant.list()
    expect(listed.map((device) => device.deviceId)).toEqual(['good'])
  })
})
