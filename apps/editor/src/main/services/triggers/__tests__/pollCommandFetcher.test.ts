/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/triggers/pollCommandFetcher.ts
 *--------------------------------------------------------------------------------------------*/

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import type { ILogger } from '@universe-editor/platform'
import {
  createPollCommandFetcher,
  describePollExecError,
  parsePollStdout,
  POLL_MAX_PAYLOAD_VALUE_LENGTH,
  toPayloadValue,
} from '../pollCommandFetcher.js'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    // A killed child can still hold the cwd on Windows for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt >= 10) throw err
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

function createLogger(): { logger: ILogger; warns: string[] } {
  const warns: string[] = []
  const logger = {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warns.push(message),
    error: () => undefined,
    flush: () => undefined,
  } as unknown as ILogger
  return { logger, warns }
}

describe('parsePollStdout', () => {
  it('accepts a JSON array and normalizes scalar payloads', () => {
    const result = parsePollStdout(
      JSON.stringify([{ id: 7, title: 'seven', done: false, nested: { a: 1 }, missing: null }]),
      'id',
    )
    expect(result).toEqual({
      ok: true,
      items: [
        {
          key: '7',
          payload: { id: 7, title: 'seven', done: false, nested: '{"a":1}' },
        },
      ],
    })
  })

  it('accepts an object with an items array', () => {
    const result = parsePollStdout('{"items":[{"id":"A"}]}', 'id')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items[0]?.key).toBe('A')
  })

  it('imports a missing id as a warning without echoing the item', () => {
    const { logger, warns } = createLogger()
    const result = parsePollStdout('[{"id":"A"},{"title":"no id"},{"id":"B"},[]]', 'id', logger)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items.map((item) => item.key)).toEqual(['A', 'B'])
    expect(warns).toHaveLength(2)
    expect(warns.join(' ')).not.toContain('no id')
  })

  it('rejects invalid JSON and the wrong top-level shape', () => {
    expect(parsePollStdout('not json', 'id').ok).toBe(false)
    expect(parsePollStdout('{"entries":[]}', 'id').ok).toBe(false)
    expect(parsePollStdout('"text"', 'id').ok).toBe(false)
  })

  it('truncates nested payload values', () => {
    const long = { data: 'x'.repeat(POLL_MAX_PAYLOAD_VALUE_LENGTH * 2) }
    const value = toPayloadValue(long)
    expect(typeof value).toBe('string')
    expect((value as string).length).toBe(POLL_MAX_PAYLOAD_VALUE_LENGTH)
  })
})

describe('createPollCommandFetcher', () => {
  async function scriptDir(script: string): Promise<string> {
    const dir = mkTempDir('ue-triggers-poll-')
    dirs.push(dir)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'fetch.js'), script, 'utf8')
    return dir
  }

  it('runs the command in the workspace and parses stdout', async () => {
    const dir = await scriptDir("console.log(JSON.stringify([{ id: 'A', title: 't' }]))\n")
    const fetcher = createPollCommandFetcher()
    const result = await fetcher({
      command: 'node fetch.js',
      cwd: dir,
      timeoutSec: 20,
      keyField: 'id',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.items[0]?.payload['title']).toBe('t')
  })

  it('reports a non-zero exit without the command output', async () => {
    const dir = await scriptDir("console.error('STDERR-CONTENT'); process.exit(3)\n")
    const fetcher = createPollCommandFetcher()
    const result = await fetcher({
      command: 'node fetch.js',
      cwd: dir,
      timeoutSec: 20,
      keyField: 'id',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('3')
      expect(result.error).not.toContain('STDERR-CONTENT')
    }
  })

  it('maps a missing executable to a readable error', async () => {
    const dir = mkTempDir('ue-triggers-poll-')
    dirs.push(dir)
    const fetcher = createPollCommandFetcher()
    const result = await fetcher({
      command: 'ue-definitely-missing-command',
      cwd: dir,
      timeoutSec: 5,
      keyField: 'id',
    })
    expect(result.ok).toBe(false)
  })

  it('maps a timeout and an oversized stdout to distinct errors', () => {
    expect(describePollExecError({ killed: true }, 30)).toContain('timed out')
    expect(describePollExecError({ signal: 'SIGKILL' }, 30)).toContain('timed out')
    expect(describePollExecError({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 30)).toContain(
      '1 MB',
    )
    expect(describePollExecError({ code: 2 }, 30)).toContain('2')
    expect(describePollExecError({}, 30)).toContain('could not be started')
  })

  it('warns (without content) about skipped items', async () => {
    const { logger, warns } = createLogger()
    const dir = await scriptDir('console.log(JSON.stringify([{ nope: 1 }]))\n')
    const fetch = createPollCommandFetcher(logger)
    const result = await fetch({
      command: 'node fetch.js',
      cwd: dir,
      timeoutSec: 20,
      keyField: 'id',
    })
    expect(result).toEqual({ ok: true, items: [] })
    expect(warns).toHaveLength(1)
    expect(warns[0]).not.toContain('nope')
  })
})
