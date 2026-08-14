import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createStorage, workspaceIdFromUri, workspaceStoragePath } from '../storage.js'

// Stub electron app.getPath() — workspaceStoragePath uses it. We don't import
// the real module in the test; cheap stub so the function is callable in node.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
}))

// Gate fs.mkdir: a storage write starts with mkdir, so holding it makes the
// write in-flight for as long as the test needs to pile up more set() calls.
// vi.mock('node:fs') is impossible here (storage.ts imports sync fs members),
// so spy on the live promises object instead — fs.promises is a shared object.
function makeWriteGate(): { hold: () => void; release: () => void } {
  const realMkdir = fs.mkdir
  let gate: Promise<void> | null = null
  let releaseFn: (() => void) | null = null
  const gated = (async (path: string, options?: object) => {
    if (gate) await gate
    return (realMkdir as (p: string, o?: object) => Promise<string | undefined>)(path, options)
  }) as typeof fs.mkdir
  vi.spyOn(fs, 'mkdir').mockImplementation(gated)
  return {
    hold: () => {
      gate = new Promise<void>((r) => {
        releaseFn = r
      })
    },
    release: () => {
      releaseFn?.()
      gate = null
      releaseFn = null
    },
  }
}

describe('createStorage', () => {
  let file: string

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-storage-'))
    file = join(dir, 'state.json')
  })

  afterEach(async () => {
    await fs.rm(dirname(file), { recursive: true, force: true })
  })

  it('returns undefined for unknown key when file is missing', async () => {
    const s = createStorage(file)
    expect(await s.get('missing')).toBeUndefined()
  })

  it('persists set values and reads them back', async () => {
    const s = createStorage(file)
    await s.set('workbench.layout', { sidebar: 240, panel: 200 })
    expect(await s.get('workbench.layout')).toEqual({ sidebar: 240, panel: 200 })
  })

  it('writes to disk and a fresh instance can read', async () => {
    const writer = createStorage(file)
    await writer.set('a', 1)
    await writer.set('b', { nested: true })

    const reader = createStorage(file)
    expect(await reader.get('a')).toBe(1)
    expect(await reader.get('b')).toEqual({ nested: true })
  })

  it('treats corrupt JSON as empty without throwing', async () => {
    await fs.writeFile(file, 'not-json-{', 'utf8')
    const s = createStorage(file)
    expect(await s.get('x')).toBeUndefined()
    await s.set('x', 42)
    expect(await s.get('x')).toBe(42)
  })

  it('removes a key and persists', async () => {
    const s = createStorage(file)
    await s.set('keep', 1)
    await s.set('drop', 2)
    await s.remove('drop')
    expect(await s.get('drop')).toBeUndefined()
    expect(await s.get('keep')).toBe(1)
    const reader = createStorage(file)
    expect(await reader.get('drop')).toBeUndefined()
    expect(await reader.get('keep')).toBe(1)
  })

  it('remove() on a missing key is a no-op', async () => {
    const s = createStorage(file)
    await expect(s.remove('never-set')).resolves.toBeUndefined()
  })

  it('flush() resolves after pending writes complete', async () => {
    const s = createStorage(file)
    await s.set('a', 1)
    await s.set('b', 2)
    await s.flush()
    const reader = createStorage(file)
    expect(await reader.get('a')).toBe(1)
    expect(await reader.get('b')).toBe(2)
  })

  it('flushSync() synchronously persists the latest state', async () => {
    const s = createStorage(file)
    await s.set('a', 1)
    await s.set('b', 2)
    // Corrupt the on-disk primary to prove flushSync rewrites from in-memory
    // cache rather than relying on the async write chain having drained.
    await fs.writeFile(file, 'clobbered-{', 'utf8')
    s.flushSync()
    const reader = createStorage(file)
    expect(await reader.get('a')).toBe(1)
    expect(await reader.get('b')).toBe(2)
  })

  it('flushSync() is a no-op before anything is read or written', () => {
    const s = createStorage(file)
    expect(() => s.flushSync()).not.toThrow()
  })

  it('keeps the previous contents as a .bak on each write', async () => {
    const s = createStorage(file)
    await s.set('v', 'first')
    await s.flush()
    await s.set('v', 'second')
    await s.flush()
    const bak = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')) as Record<string, unknown>
    expect(bak['v']).toBe('first')
    const main = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(main['v']).toBe('second')
  })

  it('recovers from .bak when the primary file is corrupt', async () => {
    const writer = createStorage(file)
    await writer.set('keep', 'me')
    await writer.flush()
    await writer.set('keep', 'me-too')
    await writer.flush()
    // Corrupt the primary; the last-good copy still lives in .bak.
    await fs.writeFile(file, 'half-written-{', 'utf8')

    const reader = createStorage(file)
    expect(await reader.get('keep')).toBe('me')
    // The corrupt primary is preserved for diagnostics rather than discarded.
    await expect(fs.readFile(`${file}.corrupt`, 'utf8')).resolves.toBe('half-written-{')
  })

  it('treats an oversized primary as corrupt and recovers from .bak without reading it', async () => {
    const writer = createStorage(file)
    await writer.set('keep', 'me')
    await writer.flush()
    await writer.set('keep', 'me-too')
    await writer.flush()
    // A valid-JSON primary whose size alone exceeds the read backstop: the old
    // code would load it as the live state and lose 'keep'; the backstop must
    // move it aside and recover 'keep' from .bak.
    const oversized = JSON.stringify({ intruder: 'x'.repeat(2048) })
    await fs.writeFile(file, oversized, 'utf8')

    const reader = createStorage(file, { maxReadBytes: 1024 })
    expect(await reader.get('keep')).toBe('me')
    expect(await reader.get('intruder')).toBeUndefined()
    // The oversized primary is preserved for diagnostics rather than discarded.
    await expect(fs.readFile(`${file}.corrupt`, 'utf8')).resolves.toBe(oversized)
  })

  it('refuses to persist a value exceeding the size backstop', async () => {
    const s = createStorage(file, { maxValueBytes: 1024 })
    await s.set('small', 'ok')
    await expect(s.set('huge', 'x'.repeat(2048))).rejects.toThrow(/refusing to persist "huge"/)
    // The rejected write neither entered the cache nor clobbered existing content.
    expect(await s.get('huge')).toBeUndefined()
    expect(await s.get('small')).toBe('ok')
    await s.flush()
    const reader = createStorage(file)
    expect(await reader.get('small')).toBe('ok')
    expect(await reader.get('huge')).toBeUndefined()
  })
})

describe('createStorage — write coalescing', () => {
  let file: string
  let gate: ReturnType<typeof makeWriteGate>
  let writeFileSpy: MockInstance<typeof fs.writeFile>

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'universe-editor-storage-'))
    file = join(dir, 'state.json')
    gate = makeWriteGate()
    writeFileSpy = vi.spyOn(fs, 'writeFile')
  })

  afterEach(async () => {
    gate.release()
    vi.restoreAllMocks()
    await fs.rm(dirname(file), { recursive: true, force: true })
  })

  it('coalesces a burst of sets into far fewer disk writes', async () => {
    const s = createStorage(file)
    gate.hold()
    const pending = Array.from({ length: 20 }, (_, i) => s.set(`k${i}`, i))
    // First write is in-flight (gated); the other 19 must merge into one queued
    // write instead of 19 queued full-bucket serializations.
    gate.release()
    await Promise.all(pending)
    await s.flush()
    expect(writeFileSpy.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('resolves each set() promise only after its value is on disk', async () => {
    const s = createStorage(file)
    gate.hold()
    const p1 = s.set('a', 1)
    const p2 = s.set('b', 2)
    let p1Resolved = false
    void p1.then(() => {
      p1Resolved = true
    })
    // Write 1 (carrying only 'a') is still gated: p1 cannot have resolved.
    await new Promise((r) => setTimeout(r, 30))
    expect(p1Resolved).toBe(false)
    gate.release()
    await p1
    expect(JSON.parse(await fs.readFile(file, 'utf8'))['a']).toBe(1)
    await p2
    expect(JSON.parse(await fs.readFile(file, 'utf8'))['b']).toBe(2)
  })

  it('final file content is the merge of every set, nothing lost', async () => {
    const s = createStorage(file)
    gate.hold()
    const pending = Array.from({ length: 20 }, (_, i) => s.set(`k${i}`, i))
    gate.release()
    await Promise.all(pending)
    await s.flush()
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    for (let i = 0; i < 20; i++) {
      expect(onDisk[`k${i}`]).toBe(i)
    }
  })

  it('remove() participates in the same coalesced write', async () => {
    const s = createStorage(file)
    await s.set('keep', 1)
    await s.set('drop', 2)
    gate.hold()
    const p1 = s.set('later', 3)
    const p2 = s.remove('drop')
    gate.release()
    await Promise.all([p1, p2])
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk['keep']).toBe(1)
    expect(onDisk['later']).toBe(3)
    expect('drop' in onDisk).toBe(false)
  })

  it('a set landing while a write is mid-flight gets its own follow-up write', async () => {
    const s = createStorage(file)
    await s.set('seed', 0)
    await s.flush()
    const mkdirSpy = fs.mkdir as unknown as MockInstance<typeof fs.mkdir>
    const baseline = mkdirSpy.mock.calls.length
    gate.hold()
    const p1 = s.set('a', 1)
    // Wait until write 1 has serialized (without 'b') and is blocked inside
    // the gated mkdir — the merge window for it must be closed by then.
    await vi.waitFor(() => expect(mkdirSpy.mock.calls.length).toBe(baseline + 1))
    const p2 = s.set('b', 2)
    gate.release()
    await Promise.all([p1, p2])
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk['a']).toBe(1)
    expect(onDisk['b']).toBe(2)
  })

  it('a failed write does not wedge the queue; later sets still persist', async () => {
    const s = createStorage(file)
    writeFileSpy.mockRejectedValueOnce(new Error('disk full'))
    await expect(s.set('doomed', 1)).rejects.toThrow('disk full')
    await s.set('recovered', 2)
    await s.flush()
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk['doomed']).toBe(1)
    expect(onDisk['recovered']).toBe(2)
  })
})

describe('workspaceIdFromUri', () => {
  it('is stable across calls with the same input', () => {
    expect(workspaceIdFromUri('file:///tmp/a')).toBe(workspaceIdFromUri('file:///tmp/a'))
  })

  it('produces 16 hex chars', () => {
    expect(workspaceIdFromUri('file:///tmp/foo')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for distinct inputs', () => {
    expect(workspaceIdFromUri('file:///tmp/a')).not.toBe(workspaceIdFromUri('file:///tmp/b'))
  })
})

describe('workspaceStoragePath', () => {
  it('places the file under <userData>/workspaces/<id>.json', () => {
    const p = workspaceStoragePath('abcdef0123456789')
    expect(p).toContain('workspaces')
    expect(p.endsWith('abcdef0123456789.json')).toBe(true)
  })
})
