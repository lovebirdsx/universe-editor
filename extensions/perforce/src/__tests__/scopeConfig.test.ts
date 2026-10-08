/**
 * `.p4delta-scope` 的解析与读取。
 *
 * 判据全部是 fail-closed 方向的：一条被静默丢掉的 `exclude` 会让范围**放大**，所以空文件、
 * `null`、错类型、未知字段、重复键、非法路径一律报错而不是退化成缺省值；读取时也只有
 * ENOENT 才是「没有配置」。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
import { describe, expect, it } from 'vitest'

import {
  MAX_SCOPE_CONFIG_BYTES,
  SCOPE_FILE_NAME,
  ScopeConfigError,
  describeScopeConfig,
  normalizeConfigPath,
  parseScopeConfig,
  readScopeConfig,
} from '../scopeConfig.js'

function parse(text: string): ReturnType<typeof parseScopeConfig> {
  return parseScopeConfig(text)
}

/** The message a rejection carries — the only thing the user ever sees. */
function reasonOf(text: string): string {
  try {
    parse(text)
  } catch (err) {
    if (err instanceof ScopeConfigError) return err.message
    throw err
  }
  throw new Error('expected the config to be rejected')
}

describe('parseScopeConfig — the shape of a config', () => {
  it('reads the documented example', () => {
    const config = parse(
      JSON.stringify({
        include: [{ dir: '.' }],
        exclude: [{ dir: 'Generated' }, { file: 'local.txt' }],
      }),
    )
    expect(config.include).toEqual([{ path: '.', kind: 'directory' }])
    expect(config.exclude).toEqual([
      { path: 'Generated', kind: 'directory' },
      { path: 'local.txt', kind: 'file' },
    ])
  })

  it('reads the kind from the key that was written, never from what exists', () => {
    // `gen` has no extension and `notes.txt` could be a folder: the config
    // declares the type, and nothing stats the disk to second-guess it.
    const config = parse(JSON.stringify({ include: [{ file: 'gen' }, { dir: 'notes.txt' }] }))
    expect(config.include).toEqual([
      { path: 'gen', kind: 'file' },
      { path: 'notes.txt', kind: 'directory' },
    ])
  })

  it('treats an omitted include as the whole client root and [] as an explicit empty set', () => {
    expect(parse('{}').include).toBeUndefined()
    expect(parse(JSON.stringify({ exclude: [] })).include).toBeUndefined()
    expect(parse(JSON.stringify({ include: [] })).include).toEqual([])
    expect(parse(JSON.stringify({ exclude: [] })).exclude).toEqual([])
    expect(parse('{}').exclude).toEqual([])
  })

  it('keeps literal names — spaces, semicolons, CJK and p4 metacharacters', () => {
    const config = parse(JSON.stringify({ include: [{ file: ' 间距 ; 分号@x#y%z 中文.txt ' }] }))
    expect(config.include).toEqual([{ path: ' 间距 ; 分号@x#y%z 中文.txt ', kind: 'file' }])
  })
})

describe('parseScopeConfig — everything it must refuse', () => {
  it('refuses an empty body, null and a non-object', () => {
    expect(reasonOf('')).toContain('not valid JSON')
    expect(reasonOf('null')).toContain('must be a JSON object')
    expect(reasonOf('[]')).toContain('must be a JSON object')
    expect(reasonOf('42')).toContain('must be a JSON object')
  })

  it('refuses a trailing comma, a missing key and trailing text', () => {
    expect(reasonOf('{"include": [],}')).toContain('not valid JSON')
    expect(reasonOf('{"include" []}')).toContain('not valid JSON')
    expect(reasonOf('{} trailing')).toContain('not valid JSON')
  })

  /** A repeated key would REPLACE the earlier one, which is how a config
   *  silently stops excluding what the user wrote on the first line. */
  it('refuses a duplicate key rather than letting the later one win', () => {
    const message = reasonOf('{"include": [], "include": [{"dir": "."}]}')
    expect(message).toContain('not valid JSON')
    expect(message).toContain('duplicate key')
  })

  /** An unrecognized key is usually a typo (`Include`, `excludes`), and ignoring
   *  it would run a different range than the user asked for. */
  it('refuses an unknown field at either level', () => {
    expect(reasonOf(JSON.stringify({ Include: [] }))).toContain('unknown field')
    expect(reasonOf(JSON.stringify({ exclude: [{ path: 'x' }] }))).toContain('unknown field')
  })

  it('refuses a field that is not an array', () => {
    expect(reasonOf(JSON.stringify({ include: null }))).toContain('must be an array')
    expect(reasonOf(JSON.stringify({ exclude: { dir: 'x' } }))).toContain('must be an array')
  })

  it('refuses an entry that is not exactly one of dir/file', () => {
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'x', file: 'y' }] }))).toContain(
      'exactly one of',
    )
    expect(reasonOf(JSON.stringify({ include: [{}] }))).toContain('exactly one of')
    expect(reasonOf(JSON.stringify({ include: ['x'] }))).toContain('must be a JSON object')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 1 }] }))).toContain('must be a string')
  })

  it('refuses a path that is not a client-root-relative POSIX path', () => {
    expect(reasonOf(JSON.stringify({ include: [{ dir: '' }] }))).toContain('empty path')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'a\\b' }] }))).toContain('backslash')
    expect(reasonOf(JSON.stringify({ include: [{ dir: '/abs' }] }))).toContain('absolute path')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'X:/abs' }] }))).toContain('drive letter')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'a\u0000b' }] }))).toContain('NUL byte')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'a*b' }] }))).toContain('wildcard')
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'a/.../b' }] }))).toContain('...')
  })

  it('refuses a path that steps above the client root', () => {
    expect(reasonOf(JSON.stringify({ include: [{ dir: '..' }] }))).toContain(
      'steps above the client root',
    )
    expect(reasonOf(JSON.stringify({ include: [{ dir: 'a/../..' }] }))).toContain(
      'steps above the client root',
    )
  })

  it('refuses file "." — the root is a directory', () => {
    expect(reasonOf(JSON.stringify({ include: [{ file: '.' }] }))).toContain(
      'names the client root itself',
    )
    expect(reasonOf(JSON.stringify({ include: [{ file: 'a/..' }] }))).toContain(
      'names the client root itself',
    )
  })
})

describe('normalizeConfigPath', () => {
  it('normalises redundant separators and dot segments', () => {
    expect(normalizeConfigPath('./a//b/./c', 'directory')).toBe('a/b/c')
    expect(normalizeConfigPath('a/./b/../c', 'directory')).toBe('a/c')
    expect(normalizeConfigPath('.', 'directory')).toBe('.')
  })

  it('does not trim or decode a legitimate name', () => {
    expect(normalizeConfigPath(' a b ', 'file')).toBe(' a b ')
    expect(normalizeConfigPath('a%20b', 'file')).toBe('a%20b')
  })
})

describe('describeScopeConfig', () => {
  it('names the shape without pretending to resolve it', () => {
    expect(describeScopeConfig(parse('{}'))).toBe('include <the whole client root>, exclude <none>')
    expect(describeScopeConfig(parse(JSON.stringify({ include: [] })))).toContain('include <empty>')
    expect(
      describeScopeConfig(
        parse(JSON.stringify({ include: [{ dir: 'src' }], exclude: [{ file: 'x' }] })),
      ),
    ).toContain('include dir "src", exclude file "x"')
  })
})

describe('readScopeConfig', () => {
  function root(): string {
    return mkTempDir('ue-')
  }

  it('reports absence ONLY for ENOENT', () => {
    expect(readScopeConfig(root())).toEqual({ kind: 'absent' })
  })

  it('reads a well-formed config and returns the text as well as the parse', () => {
    const dir = root()
    const text = JSON.stringify({ include: [{ dir: 'src' }] })
    writeFileSync(join(dir, SCOPE_FILE_NAME), text)
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.config.include).toEqual([{ path: 'src', kind: 'directory' }])
    // The text travels with the parse: it is the local scope identity, and
    // re-reading the file to get it would reopen the window it closes.
    expect(read.text).toBe(text)
    expect(read.path).toBe(join(dir, SCOPE_FILE_NAME))
  })

  /** The destructive reading this state exists to prevent: a config the editor
   *  cannot read is NOT "no constraints". */
  it('reports an error — never absence — for a config that is not a regular file', () => {
    const dir = root()
    mkdirSync(join(dir, SCOPE_FILE_NAME))
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('error')
    if (read.kind !== 'error') return
    expect(read.reason).toContain('not a regular file')
  })

  it('reports an error for a config above the byte ceiling', () => {
    const dir = root()
    writeFileSync(join(dir, SCOPE_FILE_NAME), ' '.repeat(MAX_SCOPE_CONFIG_BYTES + 1))
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('error')
    if (read.kind !== 'error') return
    expect(read.reason).toContain('byte limit')
  })

  it('reports an error for invalid UTF-8', () => {
    const dir = root()
    writeFileSync(join(dir, SCOPE_FILE_NAME), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('error')
    if (read.kind !== 'error') return
    expect(read.reason).toContain('not valid UTF-8')
  })

  /** U+FFFD is a legal character, not evidence of a broken file: the bytes
   *  EF BF BD even spell it explicitly. Judging by "the text holds a replacement
   *  character" would refuse a name the user is allowed to write. */
  it('accepts a name that really is a replacement character', () => {
    const dir = root()
    const text = '{"include":[{"dir":"a�b"}]}'
    writeFileSync(join(dir, SCOPE_FILE_NAME), Buffer.from(text, 'utf8'))
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('ok')
    if (read.kind !== 'ok') return
    expect(read.config.include).toEqual([{ path: 'a�b', kind: 'directory' }])
  })

  /** A BOM is kept in the text (δ's `String::from_utf8` keeps it too), so a
   *  BOM-prefixed config is refused as invalid JSON rather than silently read. */
  it('keeps the byte-order mark instead of stripping it', () => {
    const dir = root()
    writeFileSync(
      join(dir, SCOPE_FILE_NAME),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"include":[]}', 'utf8')]),
    )
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('error')
    if (read.kind !== 'error') return
    expect(read.reason).toContain('not valid JSON')
  })

  it('reports an error for a body that is not a valid config', () => {
    const dir = root()
    writeFileSync(join(dir, SCOPE_FILE_NAME), '{"include": "src"}')
    const read = readScopeConfig(dir)
    expect(read.kind).toBe('error')
    if (read.kind !== 'error') return
    expect(read.reason).toContain('Invalid')
    expect(read.reason).toContain('must be an array')
  })
})
