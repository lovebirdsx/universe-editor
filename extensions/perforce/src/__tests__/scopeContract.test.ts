/**
 * `.p4delta-scope` 的共享契约向量：**同一批**用例由 δ（Rust）与编辑器（TS）各自真的执行，
 * 而不是只比「解析没报错」。
 *
 * 向量文件是从 δ 仓镜像过来的（`p4delta/tests/fixtures/scope-contract.json` →
 * `src/__tests__/fixtures/scope-contract.json`），改一侧必须改另一侧：它是这套契约唯一的
 * 语言无关真相，两侧的解析器、集合代数、路径身份与报错文案都在它上面被判。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

import {
  canonicalLocalPath,
  localPathKey,
  pathIsUnderKey,
  resolveScope,
  scopeCoversPath,
  type PathStyle,
  type ScopeEntry,
  UNIX_PATH_STYLE,
  WINDOWS_PATH_STYLE,
  hostPathStyle,
} from '../scope.js'
import {
  parseScopeConfig,
  readScopeConfig,
  SCOPE_FILE_NAME,
  type ScopeConfig,
} from '../scopeConfig.js'

interface FixtureEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
}

interface FixtureCase {
  readonly name: string
  readonly platform: 'any' | 'windows' | 'unix'
  readonly config?: string | null
  readonly targets?: readonly FixtureEntry[]
  readonly cliExcludes?: readonly FixtureEntry[]
  readonly expect: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
    readonly members?: Readonly<Record<string, boolean>>
    readonly error?: string
  }
}

interface FixtureFileBytesCase {
  readonly name: string
  readonly hex: string
  readonly expect: {
    readonly include?: readonly string[]
    readonly exclude?: readonly string[]
    readonly error?: string
  }
}

interface Fixture {
  readonly version: number
  readonly roots: { readonly windows: string; readonly unix: string }
  readonly cases: readonly FixtureCase[]
  readonly fileBytes: { readonly cases: readonly FixtureFileBytesCase[] }
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/scope-contract.json', import.meta.url), 'utf8'),
) as Fixture

function styleFor(fixtureCase: FixtureCase): { style: PathStyle; root: string } {
  if (fixtureCase.platform === 'windows') {
    return { style: WINDOWS_PATH_STYLE, root: fixture.roots.windows }
  }
  if (fixtureCase.platform === 'unix') {
    return { style: UNIX_PATH_STYLE, root: fixture.roots.unix }
  }
  const style = hostPathStyle()
  return { style, root: style.separator === '\\' ? fixture.roots.windows : fixture.roots.unix }
}

/** 向量里的目标路径：`{root}` 占位展开，其余按 client root 相对或绝对解释。 */
function absolute(raw: string, root: string, style: PathStyle): string {
  return canonicalLocalPath(raw.split('{root}').join(root), style, root)
}

function toEntries(
  entries: readonly FixtureEntry[] | undefined,
  root: string,
  style: PathStyle,
): ScopeEntry[] {
  return (entries ?? []).map((entry) => ({
    path: absolute(entry.path, root, style),
    kind: entry.kind,
  }))
}

/** 绝对路径 → client root 相对 POSIX 拼法（root 自己写 `'.'`），与向量的期望口径一致。
 *
 *  比较基准是**规范化后**的 root：范围里的条目一律是编辑器自己的 `/` 拼法
 *  （`canonicalLocalPath`），而向量给的 root 是平台拼法（Windows 上带反斜杠），
 *  直接按 `style.separator` 切会把整条路径原样返回。 */
function toRelative(path: string, root: string, style: PathStyle): string {
  const canonicalRoot = canonicalLocalPath(root, style)
  const key = localPathKey(path, style)
  const rootKey = localPathKey(canonicalRoot, style)
  if (key === rootKey) return '.'
  if (!pathIsUnderKey(key, rootKey, style)) return path
  return path
    .slice(canonicalRoot.length + 1)
    .split('/')
    .filter((part) => part !== '')
    .join('/')
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

describe('scope contract (shared vectors)', () => {
  it('mirrors the fixture the δ repository runs', () => {
    expect(fixture.version).toBe(1)
    expect(fixture.cases.length).toBeGreaterThan(30)
  })

  for (const fixtureCase of fixture.cases) {
    it(fixtureCase.name, () => {
      const { style, root } = styleFor(fixtureCase)
      const targets = toEntries(fixtureCase.targets, root, style)
      const cliExcludes = toEntries(fixtureCase.cliExcludes, root, style)

      let config: ScopeConfig | undefined
      let parseError: string | undefined
      const text = fixtureCase.config
      if (text !== null && text !== undefined) {
        try {
          config = parseScopeConfig(text)
        } catch (err) {
          parseError = String(err)
        }
      }
      const scopeFilePath = config === undefined ? null : `${root}${style.separator}.p4delta-scope`

      const resolution = resolveScope({
        clientRoot: root,
        config,
        scopeFilePath,
        targets,
        targetsDeclared: fixtureCase.targets !== undefined,
        cliExcludes,
        style,
      })
      const reason = parseError ?? (resolution.ok ? undefined : resolution.reason)
      const expected = fixtureCase.expect

      if (expected.error !== undefined) {
        expect(reason, '这一条必须是错误').toBeDefined()
        expect(reason).toContain(expected.error)
        return
      }
      if (!resolution.ok) throw new Error(`expected a resolved scope, got: ${resolution.reason}`)
      const scope = resolution.scope

      expect(sorted(scope.includes.map((e) => toRelative(e.path, root, style)))).toEqual(
        sorted(expected.include ?? []),
      )
      expect(sorted(scope.excludes.map((e) => toRelative(e.path, root, style)))).toEqual(
        sorted(expected.exclude ?? []),
      )

      for (const [relative, covered] of Object.entries(expected.members ?? {})) {
        const path =
          relative === '.'
            ? root
            : `${root}${style.separator}${relative.split('/').join(style.separator)}`
        expect(scopeCoversPath(scope, path), `${relative} 的成员关系`).toBe(covered)
      }
    })
  }

  /**
   * 配置文件**字节**层面的向量：hex 原样落盘，再走本仓真正的读取入口
   * （`readScopeConfig`），与 δ 侧的 `read_scope_file` 对同一批字节求值。
   *
   * 这一层判的是「合法 UTF-8」与「坏了」的分界：EF BF BD 是合法的 U+FFFD 字符，必须当
   * 普通文件名收下；孤立 0xFF 与截断的多字节序列才是错。按「正文里出现过替换字符」判坏
   * 会把前一种错杀，而那个字符用户完全写得出来。
   */
  it('reads the file-byte vectors the δ repository runs', () => {
    const cases = fixture.fileBytes.cases
    expect(cases.length).toBeGreaterThanOrEqual(5)
    const dir = mkTempDir('p4-scope-bytes-')
    try {
      for (const vector of cases) {
        writeFileSync(join(dir, SCOPE_FILE_NAME), Buffer.from(vector.hex, 'hex'))
        const read = readScopeConfig(dir)
        if (vector.expect.error !== undefined) {
          expect(read.kind, `${vector.name} 必须是错误`).toBe('error')
          const reason = read.kind === 'error' ? read.reason : ''
          expect(reason, `${vector.name} 的错误文案`).toContain(vector.expect.error)
          continue
        }
        if (read.kind !== 'ok') {
          throw new Error(`${vector.name}: 期望读成合法配置，实际是 ${read.kind}`)
        }
        expect(
          read.config.include?.map((entry) => entry.path) ?? [],
          `${vector.name} include`,
        ).toEqual(vector.expect.include ?? [])
        expect(
          read.config.exclude.map((entry) => entry.path),
          `${vector.name} exclude`,
        ).toEqual(vector.expect.exclude ?? [])
      }
    } finally {
      removeDirWithRetry(dir)
    }
  })
})
