/**
 * `.p4delta-scope` 的严格解析：client root 下的 JSON 配置 → 一组带类型的条目。
 *
 * 契约与 Rust 侧 `p4delta/src/scope_config.rs` 逐字对齐，语言无关的向量在
 * `src/__tests__/fixtures/scope-contract.json`（与 δ 仓 `tests/fixtures/scope-contract.json`
 * 同一份）。两侧各写一遍解析是刻意的：编辑器要能在不启动 δ 的情况下说清「当前生效的范围是
 * 什么」，δ 要能在没有编辑器的情况下守住同一份契约；共享的是**行为**，不是实现。
 *
 * - 每条恰好一个 `dir` 或 `file`：类型由**写出来的那个键**决定，不 stat、不按本地存不存在猜。
 * - 省略 `include`（或整份写成 `{}`）＝整个 client root；`include: []` 是明确的空集。
 * - 路径必须是 **client root 相对的本地路径**，分隔符只认 `/`；反斜杠是错误而不是另一种写法。
 * - 空文件、`null`、错类型、未知字段、重复键、非法路径一律报错，绝不退化成缺省值——
 *   一条被静默丢掉的 `exclude` 会让范围**放大**，那是 fail-open 的方向。
 *
 * 解析是纯函数；读文件、判 ENOENT、限长与编码校验在 {@link readScopeConfig} 那一侧。
 */
import { readFileSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'

/** 持久范围配置的文件名。固定放在 client root 下，不再向上查找。 */
export const SCOPE_FILE_NAME = '.p4delta-scope'

/** 配置文件的大小上限。配置是人手写的几十行，超过这个量级多半是拿错了文件。 */
export const MAX_SCOPE_CONFIG_BYTES = 1024 * 1024

/** 一条配置条目：已归一的 **client root 相对 POSIX 路径**（`'.'` 表示 root 自身）+ 类型。 */
export interface ScopeConfigEntry {
  readonly path: string
  readonly kind: ScopeEntryKind
}

/** 一份解析好的 `.p4delta-scope`。 */
export interface ScopeConfig {
  /** `undefined` = 没写 `include`（＝整个 root）；`[]` = 写成了空数组（＝明确的空集）。 */
  readonly include: readonly ScopeConfigEntry[] | undefined
  readonly exclude: readonly ScopeConfigEntry[]
}

export type ScopeEntryKind = 'directory' | 'file'

/** 一份配置正文被拒绝。消息里带「哪里错、为什么」，因为用户看到的就只有这一句。 */
export class ScopeConfigError extends Error {}

// ---- 严格 JSON ----

/**
 * 一个保留了「对象里出现过哪些键」的 JSON 值。
 *
 * 用 `JSON.parse` 的话后来的键会直接盖掉前一个，而配置里一个重复的 `include` 会把整份范围
 * 换成另一个——静默放大范围，正是这套契约要 fail closed 的方向。所以这里自带一个只认
 * JSON 语法的小解析器：它不需要理解语义，只需要**一个键也不丢**。
 */
type JsonValue =
  | { readonly type: 'null' }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'array'; readonly items: readonly JsonValue[] }
  | { readonly type: 'object'; readonly entries: readonly (readonly [string, JsonValue])[] }

function typeName(value: JsonValue): string {
  switch (value.type) {
    case 'null':
      return 'null'
    case 'boolean':
      return 'a boolean'
    case 'number':
      return 'a number'
    case 'string':
      return 'a string'
    case 'array':
      return 'an array'
    case 'object':
      return 'an object'
  }
}

class JsonSyntaxError extends Error {}

class JsonReader {
  private index = 0

  constructor(private readonly text: string) {}

  parse(): JsonValue {
    this.skipWhitespace()
    const value = this.readValue()
    this.skipWhitespace()
    if (this.index !== this.text.length) this.fail('trailing characters after the JSON value')
    return value
  }

  private fail(what: string): never {
    throw new JsonSyntaxError(`${what} at byte ${this.index}`)
  }

  private skipWhitespace(): void {
    // JSON 的空白就是这四个；不允许 `\n` 之外的任何控制字符当分隔。
    while (this.index < this.text.length && /[ \t\n\r]/.test(this.text[this.index]!)) this.index++
  }

  private readValue(): JsonValue {
    const char = this.text[this.index]
    if (char === undefined) this.fail('unexpected end of input')
    if (char === '{') return this.readObject()
    if (char === '[') return this.readArray()
    if (char === '"') return { type: 'string', value: this.readString() }
    if (char === 't' || char === 'f' || char === 'n') return this.readLiteral()
    if (char === '-' || (char >= '0' && char <= '9')) return this.readNumber()
    return this.fail(`unexpected character ${JSON.stringify(char)}`)
  }

  private readObject(): JsonValue {
    this.index++ // '{'
    const entries: Array<readonly [string, JsonValue]> = []
    this.skipWhitespace()
    if (this.text[this.index] === '}') {
      this.index++
      return { type: 'object', entries }
    }
    for (;;) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') this.fail('expected a property name')
      const key = this.readString()
      if (entries.some((existing) => existing[0] === key)) {
        throw new JsonSyntaxError(
          `duplicate key ${JSON.stringify(key)}; the config is read as written, so a repeated ` +
            `key would silently replace the earlier one`,
        )
      }
      this.skipWhitespace()
      if (this.text[this.index] !== ':') this.fail('expected ":"')
      this.index++
      this.skipWhitespace()
      entries.push([key, this.readValue()])
      this.skipWhitespace()
      const next = this.text[this.index]
      if (next === ',') {
        this.index++
        continue
      }
      if (next === '}') {
        this.index++
        return { type: 'object', entries }
      }
      this.fail('expected "," or "}"')
    }
  }

  private readArray(): JsonValue {
    this.index++ // '['
    const items: JsonValue[] = []
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index++
      return { type: 'array', items }
    }
    for (;;) {
      this.skipWhitespace()
      items.push(this.readValue())
      this.skipWhitespace()
      const next = this.text[this.index]
      if (next === ',') {
        this.index++
        continue
      }
      if (next === ']') {
        this.index++
        return { type: 'array', items }
      }
      this.fail('expected "," or "]"')
    }
  }

  private readString(): string {
    this.index++ // '"'
    let out = ''
    for (;;) {
      const char = this.text[this.index]
      if (char === undefined) this.fail('unterminated string')
      this.index++
      if (char === '"') return out
      if (char !== '\\') {
        if (char.charCodeAt(0) < 0x20) this.fail('a raw control character in a string')
        out += char
        continue
      }
      const escape = this.text[this.index]
      if (escape === undefined) this.fail('unterminated escape sequence')
      this.index++
      switch (escape) {
        case '"':
          out += '"'
          break
        case '\\':
          out += '\\'
          break
        case '/':
          out += '/'
          break
        case 'b':
          out += '\b'
          break
        case 'f':
          out += '\f'
          break
        case 'n':
          out += '\n'
          break
        case 'r':
          out += '\r'
          break
        case 't':
          out += '\t'
          break
        case 'u': {
          const hex = this.text.slice(this.index, this.index + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('expected four hexadecimal digits after \\u')
          this.index += 4
          out += String.fromCharCode(parseInt(hex, 16))
          break
        }
        default:
          this.fail(`unknown escape ${JSON.stringify(`\\${escape}`)}`)
      }
    }
  }

  private readLiteral(): JsonValue {
    for (const [word, value] of [
      ['true', { type: 'boolean', value: true } as const],
      ['false', { type: 'boolean', value: false } as const],
      ['null', { type: 'null' } as const],
    ] as const) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length
        return value
      }
    }
    return this.fail('expected true, false or null')
  }

  private readNumber(): JsonValue {
    const start = this.index
    if (this.text[this.index] === '-') this.index++
    const digitsStart = this.index
    while (isDigit(this.text[this.index])) this.index++
    if (this.index === digitsStart) this.fail('expected a digit')
    if (this.text[this.index] === '.') {
      this.index++
      const fractionStart = this.index
      while (isDigit(this.text[this.index])) this.index++
      if (this.index === fractionStart) this.fail('expected a digit after "."')
    }
    const exponent = this.text[this.index]
    if (exponent === 'e' || exponent === 'E') {
      this.index++
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index++
      const exponentStart = this.index
      while (isDigit(this.text[this.index])) this.index++
      if (this.index === exponentStart) this.fail('expected a digit in the exponent')
    }
    const raw = this.text.slice(start, this.index)
    const value = Number(raw)
    if (!Number.isFinite(value)) this.fail(`the number ${raw} is out of range`)
    return { type: 'number', value }
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

// ---- 语义 ----

/**
 * 解析一份配置文件的正文。
 *
 * 报错消息里带上与 δ 相同的句子，因为两侧是同一个契约的两份实现：用户在编辑器里看到的
 * 「配置哪里不对」，与他在命令行下看到的是同一句话。
 */
export function parseScopeConfig(text: string): ScopeConfig {
  let value: JsonValue
  try {
    value = new JsonReader(text).parse()
  } catch (err) {
    if (err instanceof JsonSyntaxError) {
      throw new ScopeConfigError(`not valid JSON: ${err.message}`)
    }
    throw err
  }

  const object = expectObject(value, 'the config')
  for (const [key] of object) {
    if (key !== 'include' && key !== 'exclude') {
      throw new ScopeConfigError(
        `unknown field ${JSON.stringify(key)}; the config accepts only "include" and "exclude" ` +
          `(an unrecognized key is usually a typo, and ignoring it would silently change the scope)`,
      )
    }
  }

  const includeField = object.find(([key]) => key === 'include')
  const excludeField = object.find(([key]) => key === 'exclude')
  const include = includeField === undefined ? undefined : parseEntries(includeField[1], 'include')
  const exclude = excludeField === undefined ? [] : parseEntries(excludeField[1], 'exclude')

  return { include, exclude }
}

/** 面向报错信息的整份说明：`include dir ".", exclude dir "gen"`。 */
export function describeScopeConfig(config: ScopeConfig): string {
  const parts: string[] = []
  if (config.include === undefined) {
    parts.push('include <the whole client root>')
  } else if (config.include.length === 0) {
    parts.push('include <empty>')
  } else {
    parts.push(`include ${describeEntries(config.include)}`)
  }
  parts.push(
    config.exclude.length === 0 ? 'exclude <none>' : `exclude ${describeEntries(config.exclude)}`,
  )
  return parts.join(', ')
}

function describeEntries(entries: readonly ScopeConfigEntry[]): string {
  return entries
    .map((entry) => `${entry.kind === 'directory' ? 'dir' : 'file'} ${JSON.stringify(entry.path)}`)
    .join(', ')
}

function expectObject(value: JsonValue, what: string): readonly (readonly [string, JsonValue])[] {
  if (value.type !== 'object') {
    throw new ScopeConfigError(`${what} must be a JSON object, got ${typeName(value)}`)
  }
  return value.entries
}

/** 条目数组。必须显式写成数组：`null` 与别的类型都不是「没有」——只有缺席才是。 */
function parseEntries(value: JsonValue, field: string): ScopeConfigEntry[] {
  if (value.type !== 'array') {
    throw new ScopeConfigError(
      `${JSON.stringify(field)} must be an array, got ${typeName(value)}; write [] when there is ` +
        `nothing in it`,
    )
  }
  return value.items.map((item, index) => parseEntry(item, `${field}[${index}]`))
}

function parseEntry(value: JsonValue, what: string): ScopeConfigEntry {
  const object = expectObject(value, what)
  for (const [key] of object) {
    if (key !== 'dir' && key !== 'file') {
      throw new ScopeConfigError(
        `${what}: unknown field ${JSON.stringify(key)}; an entry is either {"dir": …} or {"file": …}`,
      )
    }
  }

  const dir = object.find(([key]) => key === 'dir')
  const file = object.find(([key]) => key === 'file')
  let field: string
  let kind: ScopeEntryKind
  let raw: JsonValue
  if (dir !== undefined && file === undefined) {
    field = 'dir'
    kind = 'directory'
    raw = dir[1]
  } else if (dir === undefined && file !== undefined) {
    field = 'file'
    kind = 'file'
    raw = file[1]
  } else if (dir !== undefined && file !== undefined) {
    throw new ScopeConfigError(
      `${what}: exactly one of "dir" or "file" is allowed; two of them would make the type a ` +
        `guess, and a guess can widen the scope`,
    )
  } else {
    throw new ScopeConfigError(`${what}: expected exactly one of "dir" or "file"`)
  }

  if (raw.type !== 'string') {
    throw new ScopeConfigError(
      `${what}: ${JSON.stringify(field)} must be a string, got ${typeName(raw)}`,
    )
  }

  try {
    return { path: normalizeConfigPath(raw.value, kind), kind }
  } catch (err) {
    if (err instanceof ScopeConfigError) throw new ScopeConfigError(`${what}: ${err.message}`)
    throw err
  }
}

/**
 * 把配置里的路径归一成 client root 相对 POSIX 路径（`'.'` 表示 root 自身）。
 *
 * 自己的组件解析而不是交给 `node:path`：配置的语法是固定的 POSIX 形状，与跑在哪台机器上
 * 无关——交给平台路径 API 会让同一份配置在两个平台上语义不同（Windows 上 `\` 变成分隔符、
 * 盘符被当根），而这份配置是要在编辑器与 CLI 之间共享的。
 */
export function normalizeConfigPath(raw: string, kind: ScopeEntryKind): string {
  if (raw === '') throw new ScopeConfigError('empty path')
  if (raw.includes('\0')) throw new ScopeConfigError(`${JSON.stringify(raw)} contains a NUL byte`)
  if (raw.includes('\\')) {
    throw new ScopeConfigError(
      `${JSON.stringify(raw)} contains a backslash; the config uses "/" as its only separator`,
    )
  }
  if (raw.startsWith('/')) {
    throw new ScopeConfigError(
      `${JSON.stringify(raw)} is an absolute path; config entries are relative to the client root`,
    )
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    throw new ScopeConfigError(
      `${JSON.stringify(raw)} starts with a drive letter; config entries are relative to the ` +
        `client root`,
    )
  }
  const wildcard = /[*?]/.exec(raw)
  if (wildcard !== null) {
    throw new ScopeConfigError(
      `${JSON.stringify(raw)} contains the wildcard ${JSON.stringify(wildcard[0])}; config ` +
        `entries are literal local paths, one per "dir"/"file" entry`,
    )
  }

  const components: string[] = []
  for (const component of raw.split('/')) {
    if (component === '' || component === '.') continue
    if (component === '..') {
      if (components.pop() === undefined) {
        throw new ScopeConfigError(
          `${JSON.stringify(raw)} steps above the client root; every step of the path must stay ` +
            `inside it`,
        )
      }
      continue
    }
    if (component === '...') {
      throw new ScopeConfigError(
        `${JSON.stringify(raw)} contains "..."; that is p4's recursive wildcard, not a path ` +
          `component. A directory is written as {"dir": "…"} — the type is declared, not spelled ` +
          `with a suffix`,
      )
    }
    components.push(component)
  }

  if (components.length === 0) {
    if (kind === 'directory') return '.'
    throw new ScopeConfigError(
      `${JSON.stringify(raw)} names the client root itself, which is a directory, not a file`,
    )
  }
  return components.join('/')
}

// ---- 读文件 ----

/** {@link readScopeConfig} 的结论。只有 `absent` 是「没有配置」——别的都不是。 */
export type ScopeConfigRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly path: string; readonly reason: string }
  | {
      readonly kind: 'ok'
      readonly path: string
      readonly text: string
      readonly config: ScopeConfig
    }

/**
 * 读 client root 下的 `.p4delta-scope`。
 *
 * 只有 **ENOENT** 才是「没有配置」：权限不足、路径是目录、编码不是 UTF-8、正文不是合法
 * JSON 都不是——把它们读成「没有配置」会让范围**放大**成整个 root，而调用方以为配置还在。
 *
 * 返回 `text` 是因为调用方还要拿它当范围身份（配置内容的本地 digest），再读一遍没有必要。
 */
export function readScopeConfig(clientRoot: string): ScopeConfigRead {
  const path = join(clientRoot, SCOPE_FILE_NAME)
  let stats: Stats
  try {
    stats = statSync(path)
  } catch (err) {
    if (isNotFound(err)) return { kind: 'absent' }
    return { kind: 'error', path, reason: `Failed to read ${path}: ${String(err)}` }
  }

  if (!stats.isFile()) {
    return {
      kind: 'error',
      path,
      reason:
        `${path} is not a regular file. A missing config means "no extra limit inside the client ` +
        `root"; anything else is an error rather than silently the whole client.`,
    }
  }
  if (stats.size > MAX_SCOPE_CONFIG_BYTES) {
    return {
      kind: 'error',
      path,
      reason: `${path} is ${stats.size} bytes, above the ${MAX_SCOPE_CONFIG_BYTES} byte limit for a scope config.`,
    }
  }

  // 坏 UTF-8 由**解码器**判，不靠「正文里有没有 U+FFFD」：EF BF BD 是合法三字节，
  // 用户完全可以把替换字符写进文件名，而按字符猜会把这份配置错杀。`fatal` 让非法字节
  // 抛错而不是被替换；`ignoreBOM` 保留开头的 BOM 字符本身（δ 侧 `String::from_utf8`
  // 也保留它），于是 BOM 开头照旧因「不是合法 JSON」被拒，而不是被悄悄吃掉。
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (err) {
    return { kind: 'error', path, reason: `Failed to read ${path}: ${String(err)}` }
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { kind: 'error', path, reason: `${path} is not valid UTF-8.` }
  }

  try {
    return { kind: 'ok', path, text, config: parseScopeConfig(text) }
  } catch (err) {
    return { kind: 'error', path, reason: `Invalid ${path}: ${String(err)}` }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
