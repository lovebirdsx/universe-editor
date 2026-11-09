import {
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENTS_PER_PROMPT,
} from '@universe-editor/mobile-protocol'
import { URI } from '@universe-editor/platform'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ATTACHMENT_PENDING_TTL_MS,
  MAX_PENDING_ATTACHMENTS_PER_DEVICE,
  MobileAttachmentStore,
} from '../mobileAttachmentStore.js'

let root: string
let now: number
let store: MobileAttachmentStore | undefined

function makeStore(overrides: { sweepIntervalMs?: number; createId?: () => string } = {}) {
  store = new MobileAttachmentStore({
    rootDir: root,
    now: () => now,
    ...overrides,
  })
  return store
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

beforeEach(async () => {
  root = mkTempDir('ue-mobile-attachments-')
  now = 1_000_000
})

afterEach(async () => {
  store?.dispose()
  store = undefined
  removeDirWithRetry(root)
})

describe('MobileAttachmentStore', () => {
  it('stores images as base64 and files as file URIs scoped to the device', async () => {
    let nextId = 0
    const attachments = makeStore({ createId: () => `att-${++nextId}` })
    await attachments.initialize()
    const saved = await attachments.save({
      deviceId: 'dev-1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      bytes: PNG_BYTES,
    })
    expect(saved).toEqual({
      id: 'att-1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 4,
      createdAt: now,
    })

    await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('hello'),
    })
    const resolved = await attachments.resolveForPrompt('dev-1', ['att-1', 'att-2'])
    expect(resolved[0]).toEqual({
      kind: 'image',
      id: 'att-1',
      name: 'shot.png',
      mimeType: 'image/png',
      byteSize: 4,
      dataBase64: Buffer.from(PNG_BYTES).toString('base64'),
    })
    expect(resolved[1]).toMatchObject({
      kind: 'file',
      id: 'att-2',
      name: 'notes.txt',
      mimeType: 'text/plain',
      byteSize: 5,
    })
    expect(resolved[1]).toMatchObject({
      uri: URI.file(join(root, 'dev-1', 'att-2', 'notes.txt')).toString(),
    })

    const opened = await attachments.open('dev-1', 'att-2')
    expect(opened).toMatchObject({ name: 'notes.txt', mimeType: 'text/plain', size: 5 })
    expect(await readFile(opened!.path, 'utf8')).toBe('hello')
  })

  it('wipes the attachment root on initialize', async () => {
    const stale = join(root, 'dev-old', 'att-old', 'stale.txt')
    await writeFile(join(root, 'seed.txt'), 'x')
    await rm(stale, { recursive: true, force: true })
    const attachments = makeStore()
    await attachments.initialize()
    expect(await readdir(root)).toEqual([])
  })

  it('rejects unsupported image MIME types and oversized images', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    await expect(
      attachments.save({
        deviceId: 'dev-1',
        kind: 'image',
        name: 'shot.svg',
        mimeType: 'image/svg+xml',
        bytes: PNG_BYTES,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      attachments.save({
        deviceId: 'dev-1',
        kind: 'image',
        name: 'huge.png',
        mimeType: 'image/png',
        bytes: new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('never resolves or opens another device’s attachment', async () => {
    let nextId = 0
    const attachments = makeStore({ createId: () => `att-${++nextId}` })
    await attachments.initialize()
    await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('hello'),
    })
    await expect(attachments.resolveForPrompt('dev-2', ['att-1'])).rejects.toMatchObject({
      code: 'attachment_not_found',
    })
    expect(await attachments.open('dev-2', 'att-1')).toBeUndefined()
  })

  it('rejects duplicate ids and too many images per prompt', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    const ids: string[] = []
    for (let i = 0; i < MAX_IMAGE_ATTACHMENTS_PER_PROMPT + 1; i++) {
      const saved = await attachments.save({
        deviceId: 'dev-1',
        kind: 'image',
        name: `shot-${i}.png`,
        mimeType: 'image/png',
        bytes: PNG_BYTES,
      })
      ids.push(saved.id)
    }
    await expect(attachments.resolveForPrompt('dev-1', [ids[0]!, ids[0]!])).rejects.toMatchObject({
      code: 'bad_request',
    })
    await expect(
      attachments.resolveForPrompt('dev-1', ids.slice(0, MAX_IMAGE_ATTACHMENTS_PER_PROMPT + 1)),
    ).rejects.toMatchObject({ code: 'bad_request' })
    expect(ids).toHaveLength(MAX_IMAGE_ATTACHMENTS_PER_PROMPT + 1)
    await expect(
      attachments.resolveForPrompt(
        'dev-1',
        Array.from({ length: MAX_ATTACHMENTS_PER_PROMPT + 1 }, () => 'missing'),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('refuses new uploads once the pending quota is full', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS_PER_DEVICE; i++) {
      await attachments.save({
        deviceId: 'dev-1',
        kind: 'file',
        name: `f-${i}.txt`,
        mimeType: 'text/plain',
        bytes: new Uint8Array(1),
      })
    }
    await expect(
      attachments.save({
        deviceId: 'dev-1',
        kind: 'file',
        name: 'one-more.txt',
        mimeType: 'text/plain',
        bytes: new Uint8Array(1),
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('stores a name that uses the full 255-byte budget', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    const name = `${'a'.repeat(251)}.txt`
    const saved = await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name,
      mimeType: 'text/plain',
      bytes: new Uint8Array(1),
    })
    expect(saved.name).toBe(name)
    expect(await readdir(join(root, 'dev-1', saved.id))).toEqual([name])
  })

  it('reserves quota for concurrent uploads instead of overshooting', async () => {
    let nextId = 0
    const attachments = makeStore({ createId: () => `att-${++nextId}` })
    await attachments.initialize()
    const results = await Promise.allSettled(
      Array.from({ length: MAX_PENDING_ATTACHMENTS_PER_DEVICE + 1 }, (_, index) =>
        attachments.save({
          deviceId: 'dev-1',
          kind: 'file',
          name: `f-${index}.txt`,
          mimeType: 'text/plain',
          bytes: new Uint8Array(1),
        }),
      ),
    )
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ reason: { code: 'rate_limited' } })
  })

  it('rejects expired and missing files even before the sweep runs', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    const saved = await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new Uint8Array(1),
    })
    now += ATTACHMENT_PENDING_TTL_MS + 1
    await expect(attachments.resolveForPrompt('dev-1', [saved.id])).rejects.toMatchObject({
      code: 'attachment_not_found',
    })
    expect(await attachments.open('dev-1', saved.id)).toBeUndefined()

    now = 1_000_000
    const alive = await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name: 'gone.txt',
      mimeType: 'text/plain',
      bytes: new Uint8Array(1),
    })
    await rm(join(root, 'dev-1', alive.id, 'gone.txt'))
    await expect(attachments.resolveForPrompt('dev-1', [alive.id])).rejects.toMatchObject({
      code: 'attachment_not_found',
    })
    expect(await attachments.open('dev-1', alive.id)).toBeUndefined()
  })

  it('expires pending attachments through the sweep timer and deletes device folders', async () => {
    vi.useFakeTimers()
    try {
      const attachments = makeStore({ sweepIntervalMs: 100 })
      await attachments.initialize()
      const saved = await attachments.save({
        deviceId: 'dev-1',
        kind: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        bytes: new Uint8Array(1),
      })
      now += ATTACHMENT_PENDING_TTL_MS + 1
      await vi.advanceTimersByTimeAsync(100)
      await expect(attachments.resolveForPrompt('dev-1', [saved.id])).rejects.toMatchObject({
        code: 'attachment_not_found',
      })

      const again = await attachments.save({
        deviceId: 'dev-1',
        kind: 'file',
        name: 'notes.txt',
        mimeType: 'text/plain',
        bytes: new Uint8Array(1),
      })
      await attachments.deleteDevice('dev-1')
      expect(await attachments.open('dev-1', again.id)).toBeUndefined()
      expect(await readdir(root)).not.toContain('dev-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a consumed attachment downloadable for its sent TTL', async () => {
    const attachments = makeStore()
    await attachments.initialize()
    const saved = await attachments.save({
      deviceId: 'dev-1',
      kind: 'file',
      name: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new Uint8Array(1),
    })
    await attachments.consume('dev-1', [saved.id])
    now += ATTACHMENT_PENDING_TTL_MS + 1
    expect(await attachments.open('dev-1', saved.id)).toBeDefined()
    await expect(attachments.resolveForPrompt('dev-1', [saved.id])).resolves.toHaveLength(1)
  })
})
