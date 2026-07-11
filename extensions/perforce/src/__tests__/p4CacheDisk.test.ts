import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { P4CacheDisk } from '../p4CacheDisk.js'

/** Let the deferred manifest flush (queueMicrotask) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('P4CacheDisk', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'p4cache-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns undefined for an empty root or non-positive limit', () => {
    expect(P4CacheDisk.open('', 1024)).toBeUndefined()
    expect(P4CacheDisk.open(root, 0)).toBeUndefined()
  })

  it('persists a value and reads it back', () => {
    const disk = P4CacheDisk.open(root, 1024 * 1024)!
    expect(disk).toBeDefined()
    disk.set('print', '//depot/a#1', 'hello')
    expect(disk.get('print', '//depot/a#1')).toBe('hello')
  })

  it('survives a reopen (manifest reload)', async () => {
    const d1 = P4CacheDisk.open(root, 1024 * 1024)!
    d1.set('print', '//depot/a#1', 'hello')
    await flush()

    const d2 = P4CacheDisk.open(root, 1024 * 1024)!
    expect(d2.get('print', '//depot/a#1')).toBe('hello')
  })

  it('immutable entries are written once (a second set is a no-op)', () => {
    const disk = P4CacheDisk.open(root, 1024 * 1024)!
    disk.set('print', 'k', 'first')
    disk.set('print', 'k', 'second')
    expect(disk.get('print', 'k')).toBe('first')
  })

  it('skips a single value larger than the whole cap', () => {
    const disk = P4CacheDisk.open(root, 4)!
    disk.set('print', 'k', 'way too large')
    expect(disk.get('print', 'k')).toBeUndefined()
  })

  it('evicts least-recently-used entries past the byte cap', async () => {
    // Manual clock so lastAccess ordering is deterministic (real Date.now can
    // collide within a millisecond and make the LRU victim ambiguous).
    let t = 0
    const now = () => ++t
    // Cap fits ~2 of the 10-byte values.
    const disk = P4CacheDisk.open(root, 25, now)!
    disk.set('print', 'a', '0123456789') // 10 bytes
    disk.set('print', 'b', '0123456789') // 20 bytes
    // Touch 'a' so 'b' becomes the LRU victim.
    expect(disk.get('print', 'a')).toBe('0123456789')
    disk.set('print', 'c', '0123456789') // 30 → over cap, evict LRU ('b')
    expect(disk.get('print', 'a')).toBe('0123456789')
    expect(disk.get('print', 'c')).toBe('0123456789')
    expect(disk.get('print', 'b')).toBeUndefined()
  })

  it('tolerates a corrupt manifest (starts empty)', () => {
    writeFileSync(join(root, 'manifest.json'), '{ not json', 'utf8')
    const disk = P4CacheDisk.open(root, 1024 * 1024)!
    expect(disk).toBeDefined()
    expect(disk.get('print', 'k')).toBeUndefined()
    disk.set('print', 'k', 'v')
    expect(disk.get('print', 'k')).toBe('v')
  })

  it('drops a manifest row whose value file vanished', async () => {
    const d1 = P4CacheDisk.open(root, 1024 * 1024)!
    d1.set('print', 'k', 'v')
    await flush()
    // Wipe the value file but keep the manifest.
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<
      string,
      { file: string }
    >
    const rel = Object.values(manifest)[0]!.file
    rmSync(join(root, rel), { force: true })

    const d2 = P4CacheDisk.open(root, 1024 * 1024)!
    expect(d2.get('print', 'k')).toBeUndefined()
    // And a subsequent set for the same key now succeeds (row was forgotten).
    d2.set('print', 'k', 'v2')
    expect(d2.get('print', 'k')).toBe('v2')
  })

  it('does not leave a .tmp file after an atomic write', async () => {
    const disk = P4CacheDisk.open(root, 1024 * 1024)!
    disk.set('print', 'k', 'v')
    await flush()
    expect(existsSync(join(root, 'manifest.json'))).toBe(true)
    expect(existsSync(join(root, 'manifest.json.tmp'))).toBe(false)
  })
})
