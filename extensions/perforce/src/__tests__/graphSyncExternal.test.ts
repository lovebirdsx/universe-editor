/**
 * The two files a sync run outside this editor leaves behind: the `editor_savior`
 * helper's own config under the user's home, and UGS's state file inside the
 * workspace. Both are other tools' files, so the tests here are mostly about
 * what happens when they are wrong: one malformed entry must not cost its
 * siblings, a corrupt file must read as "no records" rather than throw, and a
 * timestamp from the future must not be able to outrank everything this editor
 * records afterwards.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import {
  ExternalSyncPoints,
  parseSaviorSyncConfig,
  parseUgsState,
  SAVIOR_CONFIG_ENV,
  saviorConfigPath,
  ugsStatePath,
} from '../graphSyncExternal.js'
import { scopeKey } from '../pathUtil.js'

const CLIENT_ROOT = 'X:/p4ws/main'
const NOW = 1_800_000_000_000

/** One `editor_savior` entry, shaped exactly like the tool writes it. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ClientName: 'testclient',
    ClientRoot: CLIENT_ROOT,
    ChangeNum: 4521,
    Timestamp: 1000,
    ...overrides,
  }
}

function saviorFile(entries: Record<string, unknown>): string {
  const dir = mkTempDir('p4-savior-')
  const file = join(dir, 'sync_config.json')
  writeFileSync(file, JSON.stringify({ '//depot/branch_x': [entries] }), 'utf8')
  return file
}

let dir: string

beforeEach(() => {
  dir = mkTempDir('p4-external-')
})

describe('saviorConfigPath', () => {
  it('defaults to the tool’s own directory under the user home', () => {
    expect(saviorConfigPath({}, 'X:/home/testuser')).toBe(
      join('X:/home/testuser', '.editor_savior', 'sync_config.json'),
    )
  })

  it('honours the env override', () => {
    expect(saviorConfigPath({ [SAVIOR_CONFIG_ENV]: 'X:/tmp/other.json' }, 'X:/home/testuser')).toBe(
      'X:/tmp/other.json',
    )
  })

  it('treats an empty override as unset', () => {
    expect(saviorConfigPath({ [SAVIOR_CONFIG_ENV]: '' }, 'X:/home/testuser')).toBe(
      join('X:/home/testuser', '.editor_savior', 'sync_config.json'),
    )
  })
})

describe('ugsStatePath', () => {
  it('sits inside the client root the tool synced', () => {
    expect(ugsStatePath(CLIENT_ROOT)).toBe(join(CLIENT_ROOT, '.ugs', 'state.json'))
  })
})

describe('parseSaviorSyncConfig', () => {
  it('maps an entry to a whole-client-root record', () => {
    const records = parseSaviorSyncConfig(JSON.stringify({ '//depot/branch_x': [entry()] }), NOW)
    expect(records).toEqual([
      {
        clientRoot: CLIENT_ROOT,
        paths: [{ path: CLIENT_ROOT, isDirectory: true }],
        change: '4521',
        source: 'external',
        at: 1000,
        complete: true,
      },
    ])
  })

  it('keeps one record per workspace when a depot path lists several', () => {
    const records = parseSaviorSyncConfig(
      JSON.stringify({
        '//depot/branch_x': [entry(), entry({ ClientRoot: 'X:/p4ws/other', ChangeNum: 9 })],
      }),
      NOW,
    )
    expect(records.map((r) => r.clientRoot)).toEqual([CLIENT_ROOT, 'X:/p4ws/other'])
    expect(records.map((r) => r.change)).toEqual(['4521', '9'])
  })

  it('reads nothing from a file that is not an object of entry lists', () => {
    for (const raw of ['{ no', 'null', '[]', '"x"', '123', 'true']) {
      expect(parseSaviorSyncConfig(raw, NOW), raw).toEqual([])
    }
  })

  it('drops a malformed entry without dropping its siblings', () => {
    const records = parseSaviorSyncConfig(
      JSON.stringify({
        '//depot/branch_x': [
          entry({ ClientRoot: '' }),
          entry({ ChangeNum: undefined }),
          entry({ Timestamp: undefined }),
          entry({ ClientRoot: 'X:/p4ws/kept' }),
        ],
      }),
      NOW,
    )
    expect(records.map((r) => r.clientRoot)).toEqual(['X:/p4ws/kept'])
  })

  it('rejects a changelist that is not a positive integer', () => {
    for (const ChangeNum of ['4521', 0, -3, 4521.5, null, true]) {
      const records = parseSaviorSyncConfig(
        JSON.stringify({ '//depot/branch_x': [entry({ ChangeNum })] }),
        NOW,
      )
      expect(records, String(ChangeNum)).toEqual([])
    }
  })

  it('rejects a timestamp that is not a positive finite number', () => {
    for (const Timestamp of [0, -1, null, '1000']) {
      const records = parseSaviorSyncConfig(
        JSON.stringify({ '//depot/branch_x': [entry({ Timestamp })] }),
        NOW,
      )
      expect(records, String(Timestamp)).toEqual([])
    }
  })

  it('clamps a timestamp from the future to now', () => {
    // Nothing else guards these records: an unclamped future stamp would win
    // every comparison from here on, including against the user's own query.
    const records = parseSaviorSyncConfig(
      JSON.stringify({ '//depot/branch_x': [entry({ Timestamp: NOW + 1_000_000 })] }),
      NOW,
    )
    expect(records[0]?.at).toBe(NOW)
  })

  it('keeps the author’s spelling of the client root but matches its folded form', () => {
    const records = parseSaviorSyncConfig(
      JSON.stringify({ '//depot/branch_x': [entry({ ClientRoot: 'x:\\p4ws\\MAIN' })] }),
      NOW,
    )
    expect(records[0]?.clientRoot).toBe('x:\\p4ws\\MAIN')
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(scopeKey(records[0]!.clientRoot) === scopeKey(CLIENT_ROOT)).toBe(insensitive)
  })
})

describe('parseUgsState', () => {
  const state = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      ClientName: 'testclient',
      StreamName: '//depot/branch_x',
      CurrentChangeNumber: 4522,
      LastSyncTime: '2020-09-18T09:35:18.000Z',
      ...overrides,
    })

  it('stamps the record with the parsed sync time', () => {
    const at = Date.parse('2020-09-18T09:35:18.000Z')
    expect(parseUgsState(state(), CLIENT_ROOT, NOW)).toEqual([
      {
        clientRoot: CLIENT_ROOT,
        paths: [{ path: CLIENT_ROOT, isDirectory: true }],
        change: '4522',
        source: 'external',
        at,
        complete: true,
      },
    ])
  })

  it('takes the client root from the caller, not from the file’s ClientName', () => {
    // The file's own location is the workspace; a client recreated under another
    // name leaves the files — and the changelist describing them — where they are.
    const records = parseUgsState(state({ ClientName: 'someone-else' }), CLIENT_ROOT, NOW)
    expect(records[0]?.clientRoot).toBe(CLIENT_ROOT)
  })

  it('clamps a sync time from the future to now', () => {
    const records = parseUgsState(
      state({ LastSyncTime: new Date(NOW + 1_000_000).toISOString() }),
      CLIENT_ROOT,
      NOW,
    )
    expect(records[0]?.at).toBe(NOW)
  })

  it('falls back to a numeric Timestamp when LastSyncTime is unusable', () => {
    expect(
      parseUgsState(state({ LastSyncTime: undefined, Timestamp: 1000 }), CLIENT_ROOT, NOW)[0]?.at,
    ).toBe(1000)
    expect(
      parseUgsState(state({ LastSyncTime: 'not a date', Timestamp: 1000 }), CLIENT_ROOT, NOW)[0]
        ?.at,
    ).toBe(1000)
  })

  it('reads nothing when neither stamp is usable', () => {
    expect(parseUgsState(state({ LastSyncTime: undefined }), CLIENT_ROOT, NOW)).toEqual([])
    expect(
      parseUgsState(state({ LastSyncTime: 'not a date', Timestamp: 0 }), CLIENT_ROOT, NOW),
    ).toEqual([])
  })

  it('reads nothing without a positive integer changelist', () => {
    for (const CurrentChangeNumber of [undefined, '4522', 0, -1, 2.5]) {
      expect(
        parseUgsState(state({ CurrentChangeNumber }), CLIENT_ROOT, NOW),
        String(CurrentChangeNumber),
      ).toEqual([])
    }
  })

  it('reads nothing from a corrupt file', () => {
    expect(parseUgsState('{ no', CLIENT_ROOT, NOW)).toEqual([])
    expect(parseUgsState('[1,2]', CLIENT_ROOT, NOW)).toEqual([])
  })
})

describe('ExternalSyncPoints', () => {
  it('a missing file reads as no records', () => {
    const points = ExternalSyncPoints.open(join(dir, 'absent.json'))
    expect(points.read(CLIENT_ROOT)).toEqual([])
  })

  it('a corrupt file reads as no records', () => {
    const file = join(dir, 'broken.json')
    writeFileSync(file, '{ no', 'utf8')
    expect(ExternalSyncPoints.open(file).read(CLIENT_ROOT)).toEqual([])
  })

  it('re-reads a file that changed since the last read', () => {
    const file = saviorFile(entry())
    const points = ExternalSyncPoints.open(file)
    expect(points.read(CLIENT_ROOT).map((r) => r.change)).toEqual(['4521'])
    // A longer changelist on purpose: the change detector is mtime + size (the
    // same one the ledger uses, and enough for a file a tool rewrites minutes
    // apart), so the test must change the size to be about re-reading at all.
    writeFileSync(
      file,
      JSON.stringify({ '//depot/branch_x': [entry({ ChangeNum: 77777 })] }),
      'utf8',
    )
    expect(points.read(CLIENT_ROOT).map((r) => r.change)).toEqual(['77777'])
  })

  it('picks up a file that appears after it was opened', () => {
    // The stamp of a missing file is `undefined`; a reader that treats that as
    // "already loaded" would never see the file the tool writes later.
    const file = join(dir, 'later.json')
    const points = ExternalSyncPoints.open(file)
    expect(points.read(CLIENT_ROOT)).toEqual([])
    writeFileSync(
      file,
      JSON.stringify({ '//depot/branch_x': [entry({ ChangeNum: 7777 })] }),
      'utf8',
    )
    expect(points.read(CLIENT_ROOT).map((r) => r.change)).toEqual(['7777'])
  })

  it('reports a file that is present but holds nothing usable', () => {
    // The one case a line exists for: the file looks like an answer and is not
    // (fields renamed, changelist written as a string). It is also the only
    // moment it can be said — an unchanged file is never re-read.
    const lines: string[] = []
    const file = join(dir, 'unusable.json')
    writeFileSync(
      file,
      JSON.stringify({ '//depot/branch_x': [entry({ ChangeNum: '4521' })] }),
      'utf8',
    )
    ExternalSyncPoints.open(file, (m) => lines.push(m)).read(CLIENT_ROOT)
    expect(lines).toEqual([`[perforce] sync point: no usable record in ${file}`])
  })

  it('keeps the file’s contents out of what it reports', () => {
    const lines: string[] = []
    const file = join(dir, 'contents.json')
    writeFileSync(
      file,
      JSON.stringify({ '//depot/secret-stream': [entry({ ClientRoot: 'X:/secret-root' })] }),
      'utf8',
    )
    ExternalSyncPoints.open(file, (m) => lines.push(m)).read(CLIENT_ROOT)
    expect(lines.join('\n')).not.toContain('secret')
  })

  it('says nothing about a file that is not there', () => {
    // Absent is the normal case on a machine without these tools; a line for it
    // would be noise on every activation.
    const lines: string[] = []
    ExternalSyncPoints.open(join(dir, 'absent.json'), (m) => lines.push(m)).read(CLIENT_ROOT)
    expect(lines).toEqual([])
  })

  it('reads UGS state from inside the client root it is asked about', () => {
    const root = join(dir, 'ws')
    mkdirSync(join(root, '.ugs'), { recursive: true })
    writeFileSync(
      join(root, '.ugs', 'state.json'),
      JSON.stringify({ CurrentChangeNumber: 4522, LastSyncTime: '2020-09-18T09:35:18.000Z' }),
      'utf8',
    )
    const points = ExternalSyncPoints.open(join(dir, 'absent.json'))
    expect(points.read(root).map((r) => r.change)).toEqual(['4522'])
    // A workspace without one still has no records — the state file is per root.
    expect(points.read(join(dir, 'other-ws'))).toEqual([])
  })

  it('reads both sources together', () => {
    const file = saviorFile(entry())
    const root = join(dir, 'ws')
    mkdirSync(join(root, '.ugs'), { recursive: true })
    writeFileSync(
      join(root, '.ugs', 'state.json'),
      JSON.stringify({ CurrentChangeNumber: 4522, LastSyncTime: '2020-09-18T09:35:18.000Z' }),
      'utf8',
    )
    const points = ExternalSyncPoints.open(file)
    expect(points.read(root).map((r) => r.change)).toEqual(['4521', '4522'])
  })
})
