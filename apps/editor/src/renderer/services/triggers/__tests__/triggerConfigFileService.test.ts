/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer trigger-config file service: read/missing handling,
 *  minimal-field saves, mtime conflicts, invalid documents, duplicate ids and
 *  creating the first trigger in a new workspace file.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { FileSystemError, URI, type IFileService } from '@universe-editor/platform'
import type { TriggerConfig } from '../../../../shared/triggers/types.js'
import {
  createTrigger,
  readTriggerConfig,
  saveTriggerConfig,
  saveTriggerConfigRebased,
  triggersConfigUri,
} from '../triggerConfigFileService.js'

const WORKSPACE = URI.file('X:/workspace')
const CONFIG_URI = triggersConfigUri(WORKSPACE)

const CONFIG_TEXT = `// Header comment.
{
  "version": 1,
  "triggers": [
    {
      "id": "alpha",
      "name": "Alpha", // inline comment
      "enabled": false,
      "source": { "type": "manual" },
      "session": {
        "agent": "claude-code",
        "prompt": "Do it",
        "budget": { "maxCostUsd": 1, "timeoutMin": 30, "approvalTimeoutMin": 1440 }
      }
    }
  ]
}
`

class FakeFiles {
  readonly entries = new Map<string, { text: string; mtime: number }>()
  readonly directories = new Set<string>()
  readonly writes: string[] = []
  readonly renames: { source: string; target: string }[] = []
  renameSupported = true
  private clock = 100

  put(uri: URI, text: string): void {
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  get(uri: URI): { text: string; mtime: number } | undefined {
    return this.entries.get(uri.toString())
  }

  bump(uri: URI): void {
    const entry = this.entries.get(uri.toString())
    if (entry !== undefined) entry.mtime = ++this.clock
  }

  async readFileText(uri: URI): Promise<string> {
    const entry = this.entries.get(uri.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    return entry.text
  }

  async stat(uri: URI): Promise<{ mtime: number }> {
    const entry = this.entries.get(uri.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    return { mtime: entry.mtime }
  }

  async writeFile(uri: URI, content: string | Uint8Array): Promise<void> {
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
    this.writes.push(uri.toString())
    this.entries.set(uri.toString(), { text, mtime: ++this.clock })
  }

  async exists(uri: URI): Promise<boolean> {
    return this.entries.has(uri.toString()) || this.directories.has(uri.toString())
  }

  async createDirectory(uri: URI): Promise<void> {
    this.directories.add(uri.toString())
  }

  async rename(source: URI, target: URI, opts?: { overwrite?: boolean }): Promise<void> {
    if (!this.renameSupported) throw new Error('rename not supported')
    const entry = this.entries.get(source.toString())
    if (entry === undefined) throw new FileSystemError('not found', 'ENOENT')
    if (opts?.overwrite !== true && this.entries.has(target.toString())) {
      throw new FileSystemError('already exists', 'EEXIST')
    }
    this.entries.delete(source.toString())
    this.entries.set(target.toString(), { text: entry.text, mtime: ++this.clock })
    this.renames.push({ source: source.toString(), target: target.toString() })
  }

  async delete(uri: URI): Promise<void> {
    if (!this.entries.delete(uri.toString())) throw new FileSystemError('not found', 'ENOENT')
  }
}

function files(): FakeFiles & IFileService {
  return new FakeFiles() as unknown as FakeFiles & IFileService
}

function trigger(overrides: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    id: 'alpha',
    name: 'Alpha',
    enabled: false,
    showSession: false,
    source: { type: 'manual' },
    session: {
      agent: 'claude-code',
      prompt: 'Do it',
      budget: { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 },
    },
    concurrency: 1,
    overflow: 'queue',
    ...overrides,
  }
}

describe('triggersConfigUri', () => {
  it('joins the workspace-relative location and keeps remote schemes', () => {
    expect(triggersConfigUri(WORKSPACE).toString()).toBe(
      'file:///X:/workspace/.universe-editor/triggers.json',
    )
    expect(triggersConfigUri(URI.parse('remote-ssh://host/ws')).toString()).toBe(
      'remote-ssh://host/ws/.universe-editor/triggers.json',
    )
  })
})

describe('readTriggerConfig', () => {
  it('returns text and mtime when the file exists', async () => {
    const fs = files()
    fs.put(CONFIG_URI, CONFIG_TEXT)
    const snapshot = await readTriggerConfig(fs, WORKSPACE)
    expect(snapshot?.text).toBe(CONFIG_TEXT)
    expect(snapshot?.mtime).toBe(fs.get(CONFIG_URI)?.mtime)
  })

  it('returns undefined when the file does not exist', async () => {
    expect(await readTriggerConfig(files(), WORKSPACE)).toBeUndefined()
  })
})

describe('saveTriggerConfig', () => {
  async function snapshot(store: FakeFiles) {
    store.put(CONFIG_URI, CONFIG_TEXT)
    const base = await readTriggerConfig(store as unknown as IFileService, WORKSPACE)
    if (base === undefined) throw new Error('snapshot missing')
    return base
  }

  it('writes only the changed field and preserves comments', async () => {
    const store = files()
    const base = await snapshot(store)
    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'Alpha renamed' }))

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.text).toContain('"name": "Alpha renamed", // inline comment')
    expect(result.text).toContain('// Header comment.')
    expect(store.get(CONFIG_URI)?.text).toBe(result.text)
  })

  it('replaces the source and removes cleared optional fields', async () => {
    const store = files()
    const base = await snapshot(store)
    const result = await saveTriggerConfig(
      store,
      base,
      'alpha',
      trigger({
        source: { type: 'schedule', cron: '0 9 * * 1', onMissed: 'skip' },
        session: {
          prompt: 'Do it',
          budget: { maxCostUsd: null, timeoutMin: 45, approvalTimeoutMin: 1440 },
        },
      }),
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.text).toContain('"type": "schedule"')
    expect(result.text).toContain('"maxCostUsd": null')
    expect(result.text).not.toContain('"agent"')
  })

  it('reports a conflict instead of writing when the file changed on disk', async () => {
    const store = files()
    const base = await snapshot(store)
    store.bump(CONFIG_URI)
    const changed = store.get(CONFIG_URI)
    if (changed !== undefined) changed.text = '{"triggers": []}'

    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'New' }))
    expect(result.kind).toBe('conflict')
    expect(store.writes).toHaveLength(0)
  })

  it('detects a same-mtime content change before writing', async () => {
    const store = files()
    const base = await snapshot(store)
    const entry = store.get(CONFIG_URI)
    if (entry !== undefined) entry.text = '{"triggers": []}'

    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'New' }))
    expect(result.kind).toBe('conflict')
    expect(store.writes).toHaveLength(0)
  })

  it('serializes concurrent saves so the second one sees the first result', async () => {
    const store = files()
    const base = await snapshot(store)
    const [first, second] = await Promise.all([
      saveTriggerConfig(store, base, 'alpha', trigger({ name: 'First' })),
      saveTriggerConfig(store, base, 'alpha', trigger({ name: 'Second' })),
    ])

    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('conflict')
    expect(store.get(CONFIG_URI)?.text).toContain('"name": "First"')
  })

  it('replaces the file through a temporary file and rename', async () => {
    const store = files()
    const base = await snapshot(store)
    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'Atomic' }))

    expect(result.kind).toBe('ok')
    expect(store.renames).toHaveLength(1)
    expect(store.renames[0]?.target).toBe(CONFIG_URI.toString())
    expect(store.renames[0]?.source).toContain('.tmp-')
    expect(store.get(CONFIG_URI)?.text).toContain('"name": "Atomic"')
  })

  it('falls back to a direct write when the provider cannot rename', async () => {
    const store = files()
    store.renameSupported = false
    const base = await snapshot(store)
    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'Fallback' }))

    expect(result.kind).toBe('ok')
    expect(store.renames).toHaveLength(0)
    expect(store.writes).toContain(CONFIG_URI.toString())
    expect(store.get(CONFIG_URI)?.text).toContain('"name": "Fallback"')
    const leftovers = [...store.entries.keys()].filter((key) => key.includes('.tmp-'))
    expect(leftovers).toEqual([])
  })

  it('reports missing-trigger when the id is no longer in the file', async () => {
    const store = files()
    const base = await snapshot(store)
    const result = await saveTriggerConfig(store, base, 'gone', trigger({ id: 'gone' }))
    expect(result.kind).toBe('missing-trigger')
  })

  it('reports invalid for a malformed document, and for a still-invalid result', async () => {
    const store = files()
    store.put(CONFIG_URI, '{ not json')
    const base = await readTriggerConfig(store as unknown as IFileService, WORKSPACE)
    if (base === undefined) throw new Error('snapshot missing')
    const malformed = await saveTriggerConfig(store, base, 'alpha', trigger())
    expect(malformed.kind).toBe('invalid')

    const store2 = files()
    const base2 = await snapshot(store2)
    const badDraft = await saveTriggerConfig(store2, base2, 'alpha', trigger({ name: '' }))
    expect(badDraft.kind).toBe('invalid')
    expect(store2.writes).toHaveLength(0)
  })

  it('returns dirty-editor without writing when the JSON editor became dirty', async () => {
    const store = files()
    store.put(CONFIG_URI, CONFIG_TEXT)
    const base = await readTriggerConfig(store, WORKSPACE)
    if (base === undefined) throw new Error('missing base snapshot')

    const result = await saveTriggerConfig(store, base, 'alpha', trigger({ name: 'Renamed' }), {
      isEditorDirty: () => true,
    })

    expect(result.kind).toBe('dirty-editor')
    expect(store.writes).toHaveLength(0)
  })

  it('returns the unchanged text without writing when nothing changed', async () => {
    const store = files()
    const base = await snapshot(store)
    const result = await saveTriggerConfig(store, base, 'alpha', trigger())
    expect(result).toEqual({ kind: 'ok', text: CONFIG_TEXT, mtime: base.mtime })
    expect(store.writes).toHaveLength(0)
  })
})

describe('saveTriggerConfigRebased', () => {
  async function snapshot(store: FakeFiles) {
    store.put(CONFIG_URI, CONFIG_TEXT)
    const base = await readTriggerConfig(store as unknown as IFileService, WORKSPACE)
    if (base === undefined) throw new Error('snapshot missing')
    return base
  }

  const externallyEdited = CONFIG_TEXT.replace('// Header comment.', '// Remote header.')
    .replace('"enabled": false', '"enabled": true')
    .replace('"prompt": "Do it"', '"prompt": "Remote prompt"')
    .replace(
      '    }\n  ]',
      '    },\n    {\n      "id": "beta",\n      "name": "Beta",\n      "enabled": false,\n      "source": { "type": "manual" },\n      "session": { "prompt": "Beta task" }\n    }\n  ]',
    )

  it('applies the draft patch to the latest disk text and keeps unrelated changes', async () => {
    const store = files()
    const base = await snapshot(store)
    store.put(CONFIG_URI, externallyEdited)

    const result = await saveTriggerConfigRebased(
      store,
      base,
      'alpha',
      trigger({ name: 'Local' }),
      { origin: trigger() },
    )

    expect(result.kind).toBe('ok')
    const text = store.get(CONFIG_URI)?.text ?? ''
    expect(text).toContain('"name": "Local", // inline comment')
    expect(text).toContain('// Remote header.')
    expect(text).toContain('"prompt": "Remote prompt"')
    expect(text).toContain('"enabled": true')
    expect(text).toContain('"id": "beta"')
  })

  it('reports fields also changed on disk and only overwrites them when asked', async () => {
    const store = files()
    const base = await snapshot(store)
    store.put(CONFIG_URI, CONFIG_TEXT.replace('"name": "Alpha"', '"name": "Remote"'))

    const conflict = await saveTriggerConfigRebased(
      store,
      base,
      'alpha',
      trigger({ name: 'Local' }),
      { origin: trigger() },
    )
    expect(conflict).toEqual({ kind: 'field-conflict', fields: ['name'] })
    expect(store.writes).toHaveLength(0)
    expect(store.get(CONFIG_URI)?.text).toContain('"name": "Remote"')

    const overwritten = await saveTriggerConfigRebased(
      store,
      base,
      'alpha',
      trigger({ name: 'Local' }),
      { origin: trigger(), overwrite: true },
    )
    expect(overwritten.kind).toBe('ok')
    expect(store.get(CONFIG_URI)?.text).toContain('"name": "Local"')
  })
})

describe('createTrigger', () => {
  it('creates the directory and an empty config when the file is missing', async () => {
    const store = files()
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'first', name: 'First' }))

    expect(result.kind).toBe('ok')
    expect(store.directories.has(URI.joinPath(WORKSPACE, '.universe-editor').toString())).toBe(true)
    const written = store.get(CONFIG_URI)?.text ?? ''
    expect(written).toContain('// Agent 触发器配置')
    expect(written).toContain('"first"')
  })

  it('appends to an existing file and keeps comments', async () => {
    const store = files()
    store.put(CONFIG_URI, CONFIG_TEXT)
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'second' }))

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.text).toContain('// Header comment.')
    expect(result.text).toContain('"second"')
    expect(result.text).toContain('"alpha"')
  })

  it('rejects a duplicate id without writing', async () => {
    const store = files()
    store.put(CONFIG_URI, CONFIG_TEXT)
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'alpha' }))
    expect(result.kind).toBe('duplicate-id')
    expect(store.writes).toHaveLength(0)
  })

  it('rejects a malformed existing file without overwriting it', async () => {
    const store = files()
    store.put(CONFIG_URI, '{ not json')
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'second' }))
    expect(result.kind).toBe('invalid')
    expect(store.writes).toHaveLength(0)
  })

  it('rejects an id that already appears as an invalid entry', async () => {
    const store = files()
    store.put(CONFIG_URI, '{ "triggers": [ { "id": "broken", "source": { "type": "nope" } } ] }')
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'broken' }))
    expect(result.kind).toBe('duplicate-id')
  })

  it('serializes concurrent appends instead of losing one definition', async () => {
    const store = files()
    store.put(CONFIG_URI, CONFIG_TEXT)
    const [first, second] = await Promise.all([
      createTrigger(store, WORKSPACE, trigger({ id: 'first' })),
      createTrigger(store, WORKSPACE, trigger({ id: 'second' })),
    ])

    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    const text = store.get(CONFIG_URI)?.text ?? ''
    expect(text).toContain('"first"')
    expect(text).toContain('"second"')
  })

  it('refuses to write while the JSON editor has unsaved changes', async () => {
    const store = files()
    const result = await createTrigger(store, WORKSPACE, trigger({ id: 'first' }), {
      isEditorDirty: () => true,
    })
    expect(result.kind).toBe('dirty-editor')
    expect(store.writes).toHaveLength(0)
  })
})
