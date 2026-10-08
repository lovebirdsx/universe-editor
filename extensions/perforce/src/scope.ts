/**
 * 本轮操作范围的**本地**计算：集合代数与路径身份。
 *
 * 这份模块不再与 δ 交换任何范围协议——它直接在编辑器里算出「哪些入口在范围内、哪些被排除」，
 * 因为那份配置（`.p4delta-scope`）的解析已经是本地纯函数（{@link ./scopeConfig.js}），
 * 而 δ 只是**同一个契约的另一份实现**。两侧共享的是行为（`src/__tests__/fixtures/
 * scope-contract.json`），不是运行时握手：没有快照文件、没有回显、没有指纹、没有 TTL。
 *
 * 集合代数与 δ 的 `combine_scope` 逐条对齐：
 * - include = **配置 ∩ 目标**；配置没写 `include` 时它是 client root 本身。
 * - exclude = 配置 ∪ 操作自己的排除项，**无条件优先**。
 * - 生效的配置文件自身是隐式 file 排除。
 * - 路径按组件边界比较，大小写策略跟着平台的文件系统走（Windows/macOS 折，其余不折）。
 *
 * 平台策略是**参数**而不是 `process.platform` 的隐式读取：共享契约向量里既有 windows 档
 * 也有 unix 档，同一台机器要能跑另一档。
 */
import type { SyncScopeTarget } from './p4Filespec.js'
import {
  describeScopeConfig,
  type ScopeConfig,
  type ScopeConfigEntry,
  type ScopeEntryKind,
} from './scopeConfig.js'

export type { ScopeEntryKind } from './scopeConfig.js'

/**
 * 日常范围本轮的可用状态。
 *
 * `ready` 是唯一「知道范围」的状态：`empty` 是一个已知但为空的范围（操作无事可做，**不是**
 * 放开到整个 client 的理由），`blocked` 是配置文件读不了/坏掉，`unresolved` 是还没算过。
 * 后两者都**不等于**「没有约束」——那正是这套契约要 fail closed 的方向。
 */
export type ScopeState = 'unresolved' | 'ready' | 'empty' | 'blocked'

/** 路径身份的两条平台规则：分隔符形状与是否折大小写。 */
export interface PathStyle {
  /** 平台主分隔符。`'\\'` 表示 Windows 形状（正斜杠会被折过去），`'/'` 表示 POSIX 形状。 */
  readonly separator: string
  /** 无标题文件系统的大小写策略，见 {@link localPathKey}。 */
  readonly foldCase: boolean
}

export const WINDOWS_PATH_STYLE: PathStyle = { separator: '\\', foldCase: true }
/** macOS 与 Linux 共用分隔符形状，但只有 macOS 折大小写——所以 sep 与 fold 是两个字段。 */
export const UNIX_PATH_STYLE: PathStyle = { separator: '/', foldCase: false }

export function hostPathStyle(): PathStyle {
  if (process.platform === 'win32') return WINDOWS_PATH_STYLE
  return { separator: '/', foldCase: process.platform === 'darwin' }
}

/** 一个已定位的范围入口：绝对本地路径（保留原始大小写，盘符统一大写）+ 类型。 */
export interface ScopeEntry {
  readonly path: string
  readonly kind: ScopeEntryKind
}

/**
 * 本轮实际生效的范围：入口、排除项、隐式被排除的配置文件、以及算它们用的平台策略。
 *
 * 带上 `style` 是为了让**判断**不需要再传一遍平台参数；它是身份规则的一部分，不是装饰。
 */
export interface ScopeView {
  readonly includes: readonly ScopeEntry[]
  readonly excludes: readonly ScopeEntry[]
  /** 生效的配置文件绝对路径，或 `null`（没有配置）。它自己永远不在范围内。 */
  readonly implicitExclude: string | null
  readonly clientRoot: string
  readonly style: PathStyle
}

// ---- 路径身份 ----

/** map 比较键：统一分隔符后按平台的路径身份策略折小写。 */
export function localPathKey(path: string, style: PathStyle): string {
  const normalized = style.separator === '\\' ? path.replace(/\//g, '\\') : path
  return style.foldCase ? normalized.toLowerCase() : normalized
}

/**
 * 范围里路径的规范拼法：绝对化、分隔符统一成 `/`、盘符大写、去掉末尾分隔符（根除外）。
 *
 * 分隔符统一成 `/` 是**编辑器自己的口径**（`pathUtil.norm`、给 p4 的 filespec、以及这里给 δ 的
 * argv 都是 `/`）：p4 与 δ 都接受 `/`，而混着平台分隔符会让同一个范围在 argv、日志与拼出来的
 * filespec 里出现两种写法。**比较**与平台策略无关——{@link localPathKey} 会按平台把两侧折成
 * 同一种形状再比，所以 `C:\ws\a` 与 `C:/ws/a` 仍然是一个键。
 *
 * 不做平台 IO——相对路径按 `base` 拼接，`..` 与 `.` 按组件消解。函数的输入在编辑器里
 * 永远已经是绝对路径（client root 与工作区目录都来自 p4），所以这里是「归一」而不是
 * 「解析调用者的 cwd」。
 */
export function canonicalLocalPath(input: string, style: PathStyle, base?: string): string {
  const windows = style.separator === '\\'
  let path = windows ? input.replace(/\\/g, '/') : input
  if (!isAbsolutePathText(path, style) && base !== undefined && base !== '') {
    const root = windows ? base.replace(/\\/g, '/') : base
    path = root.endsWith('/') ? `${root}${path}` : `${root}/${path}`
  }

  // 保留 UNC / 盘根那一段的形态：`C:/` 与 `//server/share/` 不能因为折叠而变成相对路径。
  let prefix = ''
  if (windows) {
    const drive = /^([a-zA-Z]:)(\/|$)/.exec(path)
    const unc = /^(\/\/[^/]+\/[^/]+)(\/|$)/.exec(path)
    if (drive !== null) {
      prefix = `${drive[1]!.toUpperCase()}/`
      path = path.slice(drive[0].length)
    } else if (unc !== null) {
      prefix = `${unc[1]}/`
      path = path.slice(unc[0].length)
    }
  } else if (path.startsWith('/')) {
    prefix = '/'
    path = path.replace(/^\/+/, '')
  }

  const components: string[] = []
  for (const component of path.split('/')) {
    if (component === '' || component === '.') continue
    if (component === '..') {
      components.pop()
      continue
    }
    components.push(component)
  }

  const joined = components.join('/')
  if (prefix === '') return joined
  return joined === '' ? prefix : `${prefix}${joined}`
}

/** 文本层面的「绝对」判定，用于 {@link canonicalLocalPath} 的拼接分支。 */
export function isAbsolutePathText(path: string, style: PathStyle): boolean {
  if (path.startsWith('/')) return true
  if (style.separator === '\\') return /^[a-zA-Z]:[\\/]/.test(path)
  return false
}

/**
 * 按路径组件判断 `pathKey` 是否在 `dirKey` 之下：`node_modules2` 不算 `node_modules` 的子路径。
 *
 * 根目录（`C:\`、`/`）自己就以分隔符结尾，不能再要求下一位是分隔符——少了这一条，
 * `C:\` 的整个子树都会被判成「不在范围内」，而工作区边界完全可能就是一个根。
 */
export function pathIsUnderKey(pathKey: string, dirKey: string, style: PathStyle): boolean {
  return (
    pathKey.length > dirKey.length &&
    pathKey.startsWith(dirKey) &&
    (dirKey.endsWith(style.separator) || pathKey[dirKey.length] === style.separator)
  )
}

// ---- 入口匹配 ----

/** 入口是否覆盖某个路径键（不含排除判断）。目录按子树，文件要精确相等。 */
export function entriesCover(
  entries: readonly ScopeEntry[],
  key: string,
  style: PathStyle,
): boolean {
  return entries.some((entry) => entryCoversKey(entry, key, style))
}

function entryCoversKey(entry: ScopeEntry, key: string, style: PathStyle): boolean {
  const own = localPathKey(entry.path, style)
  if (key === own) return true
  return entry.kind === 'directory' && pathIsUnderKey(key, own, style)
}

/** 入口是否覆盖 `path`（自己也算）。 */
export function entryCovers(entry: ScopeEntry, path: string, style: PathStyle): boolean {
  return entryCoversKey(entry, localPathKey(path, style), style)
}

/** `outer` 是否完整包含 `inner`。文件入口是叶子，只包含它自己。 */
function entryContains(outer: ScopeEntry, inner: ScopeEntry, style: PathStyle): boolean {
  const outerKey = localPathKey(outer.path, style)
  const innerKey = localPathKey(inner.path, style)
  if (outer.kind === 'file') return inner.kind === 'file' && outerKey === innerKey
  return innerKey === outerKey || pathIsUnderKey(innerKey, outerKey, style)
}

/** 两个入口是否有交集（一个包含另一个）。 */
function entriesIntersect(a: ScopeEntry, b: ScopeEntry, style: PathStyle): boolean {
  return entryContains(a, b, style) || entryContains(b, a, style)
}

// ---- 判断 ----

/** `path` 是否落在某个 include 之内（不看排除）。 */
export function scopeIncludesPath(scope: ScopeView, path: string): boolean {
  return entriesCover(scope.includes, localPathKey(path, scope.style), scope.style)
}

/** `path` 是否被任一声明排除项或隐式的配置文件排除覆盖。 */
export function scopeExcludesPath(scope: ScopeView, path: string): boolean {
  const key = localPathKey(path, scope.style)
  if (scope.implicitExclude !== null && localPathKey(scope.implicitExclude, scope.style) === key) {
    return true
  }
  return entriesCover(scope.excludes, key, scope.style)
}

/** 范围是否覆盖 `path`：两侧都要过。排除无条件优先。 */
export function scopeCoversPath(scope: ScopeView, path: string): boolean {
  if (scopeExcludesPath(scope, path)) return false
  return scopeIncludesPath(scope, path)
}

/**
 * 范围是否**完整**覆盖一个用户点名的目标——不是「其中一部分在范围内」。
 *
 * 两半都不能省：目标必须整个坐在某个 include 里（跨界的目标会被悄悄裁掉），且没有任何
 * 排除项碰到它（目标里面的一个排除项意味着这次操作会跳过用户点名的东西）。任一半不过，
 * 都是**该问用户**的目标，而不是客户端可以悄悄收窄的。
 */
export function scopeCoversTarget(scope: ScopeView, target: SyncScopeTarget): boolean {
  const entry: ScopeEntry = {
    path: target.path,
    kind: target.isDirectory ? 'directory' : 'file',
  }
  if (!scope.includes.some((include) => entryContains(include, entry, scope.style))) return false
  if (scope.implicitExclude !== null && entryCovers(entry, scope.implicitExclude, scope.style)) {
    return false
  }
  return !scope.excludes.some((exclude) => entriesIntersect(exclude, entry, scope.style))
}

/**
 * 范围的**有效**排除集合：声明的排除项，加上隐式的配置文件自身。
 *
 * `scopeExcludesPath` 判断时也是两半都看；这里给出的是**列表**形态，给「这段范围能不能
 * 安全地交给原生 p4」那类判断用——`<dir>/...` 规格和本地目录遍历都会走进配置文件所在的
 * 那一层，对 `p4 clean` 就是删掉用户的范围配置，对 reconcile 就是把配置本身报成待新增。
 * 只有 ENOENT（根本没有配置文件）才没有这一项。
 */
export function scopeExcludeEntries(scope: ScopeView): ScopeEntry[] {
  const entries = [...scope.excludes]
  if (scope.implicitExclude !== null) {
    entries.push({ path: scope.implicitExclude, kind: 'file' })
  }
  return entries
}

/**
 * 范围的 include 是否「不可干净遍历」：某个排除项坐在某个 include 的子树里。
 *
 * 带这种洞的目录不能作为一个 `<dir>/...` 规格交给原生 p4——那个遍历会走进被排除的子树
 * （对 `p4 clean` 就是删掉用户明确挡住的内容），而能修好它的 carve 只存在于扫盘那条路：
 * 同步还要取根本没下载过的文件，本地目录遍历列不出来。
 *
 * 配置文件自身算一个洞（见 {@link scopeExcludeEntries}）：任何带配置的范围都有这一个。
 */
export function scopeHasExcludeHoles(scope: ScopeView): boolean {
  const excludes = scopeExcludeEntries(scope)
  return scope.includes.some(
    (include) =>
      include.kind === 'directory' &&
      excludes.some(
        (exclude) =>
          entryCovers(include, exclude.path, scope.style) &&
          !entryCovers(exclude, include.path, scope.style),
      ),
  )
}

/** 范围的 include 入口，转成宿主目标形态（ledger、原生回退与日志都说这一种）。 */
export function scopeTargets(scope: ScopeView): SyncScopeTarget[] {
  return scope.includes.map((entry) => ({
    path: entry.path,
    isDirectory: entry.kind === 'directory',
  }))
}

/** 目录 include 的路径列表。 */
export function scopeDirectoryRoots(scope: ScopeView): string[] {
  return scope.includes.filter((entry) => entry.kind === 'directory').map((entry) => entry.path)
}

/** 单对入口的交集，不相交时返回 `undefined`。`left` 是范围的入口，`right` 是操作的目标。 */
function intersectEntry(
  left: ScopeEntry,
  right: ScopeEntry,
  style: PathStyle,
): ScopeEntry | undefined {
  const leftKey = localPathKey(left.path, style)
  const rightKey = localPathKey(right.path, style)
  if (left.kind === 'directory' && right.kind === 'directory') {
    if (leftKey === rightKey || pathIsUnderKey(leftKey, rightKey, style)) return left
    if (pathIsUnderKey(rightKey, leftKey, style)) return right
    return undefined
  }
  if (left.kind === 'directory') {
    return leftKey === rightKey || pathIsUnderKey(rightKey, leftKey, style) ? right : undefined
  }
  if (right.kind === 'directory') {
    return leftKey === rightKey || pathIsUnderKey(leftKey, rightKey, style) ? left : undefined
  }
  return leftKey === rightKey ? left : undefined
}

/** include ∩ targets 的入口列表，整段被排除的那些已经丢掉。 */
function intersectWithin(scope: ScopeView, targets: readonly SyncScopeTarget[]): ScopeEntry[] {
  const wanted: ScopeEntry[] = targets.map((target) => ({
    path: target.path,
    kind: target.isDirectory ? 'directory' : 'file',
  }))
  const excludes = scopeExcludeEntries(scope)

  const out: ScopeEntry[] = []
  const seen = new Set<string>()
  for (const include of scope.includes) {
    for (const target of wanted) {
      const entry = intersectEntry(include, target, scope.style)
      if (entry === undefined) continue
      // 整段不在范围内（排除项就是它、或坐在它上面）——这一段没有可做的，不是「一段」。
      if (excludes.some((exclude) => entryContains(exclude, entry, scope.style))) continue
      const key = `${entry.kind}:${localPathKey(entry.path, scope.style)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

function toTarget(entry: ScopeEntry): SyncScopeTarget {
  return { path: entry.path, isDirectory: entry.kind === 'directory' }
}

/**
 * `targets` 中范围**至少覆盖了一部分**的那些，且忽略落在结果目录**内部**的排除——
 * 给「自己走这条路并自己处理洞」的操作（扫描按层 carve，δ 在自己那侧求交）。
 *
 * 在这里因为一个洞就否决整个目录是问错了问题：一个被排除的子目录会让整个操作停下来，
 * 而不是在内部被跳过——那正是「排除项不能悄悄缩小操作」的反面。完全不覆盖的部分被丢掉，
 * 不是被返回——走进被排除的目录，正是排除项失效的方式。
 */
export function scopePartsWithin(
  scope: ScopeView,
  targets: readonly SyncScopeTarget[],
): SyncScopeTarget[] {
  return intersectWithin(scope, targets).map(toTarget)
}

/**
 * `targets` 中范围覆盖的那部分，且**不允许残留排除洞**——给原生引擎用的形态
 * （`<dir>/...` 规格没法被类型化请求收窄，交集只能在这里做）。
 *
 * 某一段结果里还坐着被排除的子树时返回 `undefined`：原生 p4 会径直走进去，于是
 * `<dir>/...` 规格或本地目录遍历会碰到范围排除掉的内容——对 clean 是破坏性的，对
 * reconcile 是把用户刚过滤掉的文件又报一遍。
 *
 * 这是给「声称整段覆盖」的范围（ledger 的同步点）与原生回退用的，后者没有回答洞的能力。
 */
export function scopeTargetsWithin(
  scope: ScopeView,
  targets: readonly SyncScopeTarget[],
): SyncScopeTarget[] | undefined {
  const parts = intersectWithin(scope, targets)
  if (parts.length === 0) return undefined
  const excludes = scopeExcludeEntries(scope)
  for (const part of parts) {
    if (part.kind === 'file') continue
    // The hole test looks INTO the part: a part that already sits inside an
    // exclusion was dropped by {@link intersectWithin}, so what is left to
    // refuse is an exclusion sitting inside the part.
    if (excludes.some((exclude) => entryCovers(part, exclude.path, scope.style))) {
      return undefined
    }
  }
  return parts.map(toTarget)
}

// ---- 解析 ----

export interface ScopeResolutionRequest {
  readonly clientRoot: string
  /** 解析好的配置，或 `undefined`（没有配置文件）。 */
  readonly config: ScopeConfig | undefined
  /** 生效的配置文件绝对路径；`config` 存在时它必须给。 */
  readonly scopeFilePath: string | null
  /** 命令行目标（绝对本地路径 + 类型）。 */
  readonly targets: readonly ScopeEntry[]
  /** 命令行上确实给了目标（哪怕一条都没能定位）。 */
  readonly targetsDeclared: boolean
  /** 本次操作自己的排除项（收集降噪等），会与配置的排除项取并集。 */
  readonly cliExcludes: readonly ScopeEntry[]
  readonly style: PathStyle
}

export type ScopeResolution =
  | { readonly ok: true; readonly scope: ScopeView }
  | { readonly ok: false; readonly reason: string }

/**
 * 把 client root、范围配置与本次操作的目标合成一份 {@link ScopeView}。
 *
 * 失败时给出与 δ 同一句话的 `reason`：编辑器把它原样呈现给用户，两侧的说法不该有第二种。
 */
export function resolveScope(request: ScopeResolutionRequest): ScopeResolution {
  const { clientRoot, config, targets, targetsDeclared, cliExcludes, style } = request
  const root = canonicalLocalPath(clientRoot, style)

  if (targetsDeclared && targets.length === 0) {
    return {
      ok: false,
      reason: 'Nothing to work on: none of the given paths could be located in this client’s view.',
    }
  }
  if (config === undefined && targets.length === 0) {
    return { ok: false, reason: 'No path given; pass the folder to work on.' }
  }

  const configIncludes: ScopeEntry[] | undefined =
    config === undefined
      ? undefined
      : config.include === undefined
        ? [{ path: root, kind: 'directory' }]
        : config.include.map((entry) => resolveConfigEntry(entry, clientRoot, style))
  const configExcludes: ScopeEntry[] =
    config === undefined
      ? []
      : config.exclude.map((entry) => resolveConfigEntry(entry, clientRoot, style))

  let includes: ScopeEntry[]
  if (configIncludes === undefined) {
    includes = [...targets]
  } else if (targets.length === 0) {
    includes = configIncludes
  } else {
    const intersection: ScopeEntry[] = []
    for (const a of configIncludes) {
      for (const b of targets) {
        const entry = intersectEntry(a, b, style)
        if (entry !== undefined) intersection.push(entry)
      }
    }
    includes = intersection
  }

  const excludes = dedupeExcludeEntries([...configExcludes, ...cliExcludes], style)
  const scope: ScopeView = {
    includes: [],
    excludes,
    // 生效的配置文件自身：用**规范拼法**存（`readScopeConfig` 给的是平台形状的 join 结果），
    // 不然同一份范围里会出现两种分隔符写法。
    implicitExclude:
      config === undefined || request.scopeFilePath === null
        ? null
        : canonicalLocalPath(request.scopeFilePath, style),
    clientRoot: root,
    style,
  }

  includes = dedupeIncludeEntries(includes, scope)
  if (includes.length === 0) {
    const scopeName = request.scopeFilePath ?? 'no scope file'
    const shape = config === undefined ? 'no scope file' : describeScopeConfig(config)
    const excluded = excludes.length === 0 ? '' : `\n  excluded: ${describeEntries(excludes)}`
    const cli = cliExcludes.length === 0 ? '' : `\n  cli excludes: ${describeEntries(cliExcludes)}`
    return {
      ok: false,
      reason:
        `Nothing to work on: the given paths do not overlap the configured scope.${excluded}\n` +
        `  scope (${scopeName}): ${shape}\n  given: ${describeEntries(targets)}${cli}`,
    }
  }

  return { ok: true, scope: { ...scope, includes } }
}

function describeEntries(entries: readonly ScopeEntry[]): string {
  return entries
    .map((entry) => `${entry.kind === 'directory' ? 'dir' : 'file'} ${JSON.stringify(entry.path)}`)
    .join(', ')
}

/** 配置条目 → 绝对入口：相对路径以 **client root** 为基准。 */
export function resolveConfigEntry(
  entry: ScopeConfigEntry,
  clientRoot: string,
  style: PathStyle,
): ScopeEntry {
  // 配置条目本来就是 POSIX 相对拼法（见 `scopeConfig`），直接以 `/` 接到 root 上——
  // `canonicalLocalPath` 会把两侧的分隔符统一成编辑器的口径。
  const path =
    entry.path === '.'
      ? canonicalLocalPath(clientRoot, style)
      : canonicalLocalPath(`${clientRoot}/${entry.path}`, style)
  return { path, kind: entry.kind }
}

/** 去重排除项（同一路径说两遍是同一件事），保留声明顺序。 */
function dedupeExcludeEntries(entries: readonly ScopeEntry[], style: PathStyle): ScopeEntry[] {
  const seen = new Set<string>()
  const out: ScopeEntry[] = []
  for (const entry of entries) {
    const key = localPathKey(entry.path, style)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * 去重并剔除被排除的 include 入口：路径相同的只留一条；目录入口覆盖的子目录/文件入口丢掉。
 * 结果按路径键排序，与 δ 一致。
 */
function dedupeIncludeEntries(includes: readonly ScopeEntry[], scope: ScopeView): ScopeEntry[] {
  const result: ScopeEntry[] = []
  outer: for (const entry of includes) {
    if (scopeExcludesPath(scope, entry.path)) continue
    const entryKey = localPathKey(entry.path, scope.style)
    for (const existing of result) {
      const existingKey = localPathKey(existing.path, scope.style)
      if (
        existingKey === entryKey ||
        (existing.kind === 'directory' && pathIsUnderKey(entryKey, existingKey, scope.style))
      ) {
        continue outer
      }
    }
    if (entry.kind === 'directory') {
      for (let i = result.length - 1; i >= 0; i--) {
        const existing = result[i]!
        const existingKey = localPathKey(existing.path, scope.style)
        if (existingKey === entryKey || pathIsUnderKey(existingKey, entryKey, scope.style)) {
          result.splice(i, 1)
        }
      }
    }
    result.push(entry)
  }
  return result.sort((a, b) =>
    localPathKey(a.path, scope.style) < localPathKey(b.path, scope.style) ? -1 : 1,
  )
}

// ---- 身份 ----

/**
 * 范围的**本地**身份：client root、入口、排除项与配置文件路径的合并摘要。
 *
 * 它取代了旧的「δ 回显指纹」：编辑器已经自己算出范围，那么「范围变了没有」就该由它自己的
 * 计算回答，而不是去问一个外部进程它刚才看到了什么。用途只有一个——判断缓存/检查点是否
 * 还适用于当前范围。
 */
export function scopeIdentity(scope: ScopeView): string {
  const parts = [
    `root=${localPathKey(scope.clientRoot, scope.style)}`,
    `file=${scope.implicitExclude === null ? '' : localPathKey(scope.implicitExclude, scope.style)}`,
    `in=${scope.includes.map((e) => `${e.kind}:${localPathKey(e.path, scope.style)}`).join(',')}`,
    `ex=${scope.excludes.map((e) => `${e.kind}:${localPathKey(e.path, scope.style)}`).join(',')}`,
  ]
  return parts.join('|')
}

// ---- 收尾工具 ----

/**
 * 本地路径 → p4 file spec：目录补 `/...`，文件就是路径本身；元字符在交给 p4 之前转义一次。
 *
 * 这是**给 p4 的**形态。交给 δ 的目标是原始本地路径（它自己在 p4 边界上转义），别混用。
 */
export function entryFileSpec(entry: ScopeEntry): string {
  const escaped = escapeMetacharacters(entry.path)
  if (entry.kind === 'file') return escaped
  const trimmed = escaped.replace(/[/\\]+$/, '')
  return trimmed.endsWith('/') ? `${trimmed}...` : `${trimmed}/...`
}

/** `#` `@` `%` `*` `?` 在 p4 语法里有特殊含义，必须百分号转义；`%` 先转，免得转义自己。 */
export function escapeMetacharacters(path: string): string {
  return path
    .replace(/%/g, '%25')
    .replace(/#/g, '%23')
    .replace(/@/g, '%40')
    .replace(/\*/g, '%2A')
    .replace(/\?/g, '%3F')
}

/** 绝对本地路径的唯一合法拼法。depot 拼法（`//…`）与相对路径都不是。 */
export function isAbsoluteLocalPath(raw: string, style: PathStyle): boolean {
  if (raw === '') return false
  if (raw.startsWith('//')) return false
  if (style.separator === '\\') {
    return raw.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(raw)
  }
  return raw.startsWith('/')
}

/**
 * 本扩展自己造的 δ 形态 filespec（`<字面路径>` 或 `<字面路径>/...`）→ 类型化目标。
 *
 * 这**不是**类型化契约要消灭的那种文本往返：那些 spec 是编辑器从字面路径（{@link
 * entryFileSpec}）拼出来的，从不来自用户输入的条目文本，所以没有 `;` 拆分、没有 `-` 前缀，
 * 唯一被读的语法是 `...` 后缀，而它只由本模块写出。
 *
 * 带 p4 元字符或 depot 拼法的 spec 返回 `undefined`——调用方要把它路由到原生引擎，
 * 那里转义才有意义。
 */
export function targetsFromSpecs(
  specs: readonly string[],
  style: PathStyle,
): SyncScopeTarget[] | undefined {
  const targets: SyncScopeTarget[] = []
  for (const spec of specs) {
    if (spec === '' || /[@#*?%]/.test(spec)) return undefined
    if (spec.startsWith('//')) return undefined
    const isDirectory = spec.endsWith('/...') || spec.endsWith('\\...')
    const path = isDirectory ? spec.slice(0, -4) : spec
    if (!isAbsoluteLocalPath(path, style)) return undefined
    targets.push({ path, isDirectory })
  }
  return targets
}
