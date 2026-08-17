/*---------------------------------------------------------------------------------------------
 *  ext-packages 的纯逻辑（可单测）：版本比较、包选择、拓扑排序、发布计划、
 *  依赖完整性、工作区白名单、pack 清单校验、COMPATIBILITY/版本常量校验、协议替换校验、
 *  gallery 配置自诊断。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`版本号必须是 X.Y.Z: ${version}`)
  return match.slice(1).map((n) => Number(n))
}

/** 返回 1 / 0 / -1；非法版本抛错。语义与 scripts/release/release.mjs 一致（不 import 以避开其顶层副作用）。 */
export function compareVersions(a, b) {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  for (let i = 0; i < av.length; i++) {
    if (av[i] > bv[i]) return 1
    if (av[i] < bv[i]) return -1
  }
  return 0
}

/** 读各包 package.json，返回 [{ dir, shortName, name, version, manifest }]。解析失败抛错。 */
export function loadPackageManifests(repoRoot, dirs) {
  return dirs.map((dir) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'))
    return {
      dir,
      shortName: dir.split('/')[1],
      name: manifest.name,
      version: manifest.version,
      manifest,
    }
  })
}

/**
 * 位置参数（目录名或完整包名）过滤，无参则全选。
 * 未命中返回 { error }，否则 { selected }。
 */
export function selectPackages(all, selectors) {
  if (selectors.length === 0) return { selected: all }
  const selected = []
  for (const sel of selectors) {
    const match = all.find((p) => p.shortName === sel || p.name === sel)
    if (!match) {
      return {
        error: `未找到可发布包: ${sel}（可选: ${all.map((p) => p.shortName).join(', ') || '无'}）`,
      }
    }
    selected.push(match)
  }
  return { selected }
}

/** 'workspace:*' → { protocol: '*' } | null；workspace:^ / workspace:~ 同样识别，其它协议返回 null。 */
export function parseWorkspaceSpec(spec) {
  const match = /^workspace:(\^|~|\*)$/.exec(spec ?? '')
  return match ? { protocol: match[1] } : null
}

/**
 * Kahn 拓扑排序：边 = dependencies 中 workspace: 协议且目标在 selected 内。
 * 集合外依赖与 catalog: 不进图（集合外由依赖完整性检查兜底）。
 */
export function topologicalOrder(selected) {
  const byShort = new Map(selected.map((p) => [p.shortName, p]))
  const dependentsOf = new Map()
  const inDegree = new Map()
  for (const p of selected) {
    const deps = []
    for (const [depName, spec] of Object.entries(p.manifest.dependencies ?? {})) {
      const depShort = depName.startsWith('@') ? depName.split('/')[1] : depName
      if (!parseWorkspaceSpec(spec) || !byShort.has(depShort)) continue
      deps.push(depShort)
      if (!dependentsOf.has(depShort)) dependentsOf.set(depShort, [])
      dependentsOf.get(depShort).push(p.shortName)
    }
    inDegree.set(p.shortName, deps.length)
  }
  const queue = selected.filter((p) => inDegree.get(p.shortName) === 0).map((p) => p.shortName)
  const order = []
  while (queue.length > 0) {
    const short = queue.shift()
    order.push(short)
    for (const dependent of dependentsOf.get(short) ?? []) {
      const next = inDegree.get(dependent) - 1
      inDegree.set(dependent, next)
      if (next === 0) queue.push(dependent)
    }
  }
  if (order.length !== selected.length) {
    return { error: `检测到依赖环: ${[...inDegree.entries()].filter(([, d]) => d > 0).map(([s]) => s).join(', ')}` }
  }
  return { order: order.map((short) => byShort.get(short)) }
}

/**
 * 版本计划：本地 > latest（或从未发布）→ publish；相等 → skipped；本地更小 → 抛错。
 * publishedVersions: { shortName: latestVersion | null }。
 */
export function planPublish(selected, publishedVersions) {
  const toPublish = []
  const skipped = []
  for (const p of selected) {
    const latest = publishedVersions[p.shortName]
    if (latest == null) {
      toPublish.push(p)
      continue
    }
    const cmp = compareVersions(p.version, latest)
    if (cmp > 0) toPublish.push(p)
    else if (cmp === 0) skipped.push(p)
    else throw new Error(`本地版本 ${p.version} 低于 npm 已发布版本 ${latest}，禁止发布旧版本（${p.name}）`)
  }
  return { toPublish, skipped }
}

/**
 * 依赖完整性计划：收集 selected 包「集合外（本次不同发）的 workspace: 依赖」需要向 npm 查证的清单。
 * 依赖目标不在 SDK 集合内（如 extensions-common 等不可发布包）直接计入 errors——发布出去会指向 0.0.0 悬空版本。
 * sdkVersionMap: { shortName: version }（SDK 全量 5 件套）。
 */
export function planExternalDepQueries(selected, sdkVersionMap) {
  const selectedShorts = new Set(selected.map((p) => p.shortName))
  const queries = []
  const errors = []
  for (const p of selected) {
    for (const [depName, spec] of Object.entries(p.manifest.dependencies ?? {})) {
      const depShort = depName.startsWith('@') ? depName.split('/')[1] : depName
      if (!parseWorkspaceSpec(spec) || selectedShorts.has(depShort)) continue
      if (!(depShort in sdkVersionMap)) {
        errors.push(`${p.name} 依赖了 SDK 集合外的 workspace 包 ${depName}，无法发布`)
        continue
      }
      queries.push({
        shortName: p.shortName,
        name: p.name,
        depName,
        targetShort: depShort,
        targetVersion: sdkVersionMap[depShort],
      })
    }
  }
  return { queries, errors }
}

/**
 * 依据 npm 精确查证结果判定：queryResults = { '<depName>@<ver>': 'published' | 'missing' }。
 * 返回错误文案列表。
 */
export function assessExternalDeps(queries, queryResults) {
  const errors = []
  for (const q of queries) {
    if (queryResults[`${q.depName}@${q.targetVersion}`] !== 'published') {
      errors.push(
        `${q.name} 依赖的 ${q.depName}@${q.targetVersion} 未在 npm 发布；先发布依赖包或将其加入本次发布集合`,
      )
    }
  }
  return errors
}

function pathInDirs(path, dirs) {
  return dirs.some((dir) => path === dir || path.startsWith(`${dir}/`))
}

/** git status --porcelain 输出中白名单目录之外的行（rename 行两侧路径都判定）。 */
export function unexpectedChanges(statusLines, allowedDirs) {
  const out = []
  for (const line of statusLines) {
    if (!line) continue
    const pathPart = line.slice(3)
    const paths = pathPart.split(' -> ')
    if (paths.every((p) => pathInDirs(p, allowedDirs))) continue
    out.push(line)
  }
  return out
}

/** 提取 pnpm pack --dry-run 输出中 Tarball Contents 与 Tarball Details 之间的文件清单。 */
export function parsePackListing(stdout) {
  const start = stdout.indexOf('Tarball Contents')
  const end = stdout.indexOf('Tarball Details')
  if (start < 0 || end < 0 || end <= start) return { error: 'pack 输出缺少 Tarball Contents/Details 段' }
  const files = stdout
    .slice(start + 'Tarball Contents'.length, end)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return { files }
}

/** pack 内容硬性校验。isBin：要求 dist/cli.js 在列；hasTemplates：要求 templates/ 下有文件。 */
export function checkPackListing(files, { isBin, hasTemplates } = {}) {
  const errors = []
  const has = (f) => files.includes(f)
  if (files.some((f) => f.startsWith('dist/__tests__/'))) errors.push('pack 内容含 dist/__tests__/')
  if (!has('LICENSE')) errors.push('pack 内容缺少 LICENSE')
  if (!has('README.md')) errors.push('pack 内容缺少 README.md')
  if (isBin && !has('dist/cli.js')) errors.push('pack 内容缺少 bin 入口 dist/cli.js')
  if (hasTemplates && !files.some((f) => f.startsWith('templates/'))) errors.push('pack 内容缺少 templates/')
  return errors
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** COMPATIBILITY.md 是否含该版本的变更记录条目（格式 `- \`0.12.0\` — ...`）。 */
export function hasCompatibilityEntry(text, version) {
  return new RegExp(`^- \`${escapeRegExp(version)}\` —`, 'm').test(text)
}

/** extension-api src/index.ts 的 `export const version` 是否与 package.json 一致。 */
export function apiVersionConstantMatches(indexTsText, version) {
  return new RegExp(`^export const version = '${escapeRegExp(version)}'`, 'm').test(indexTsText)
}

function extractString(text, re, label) {
  const match = re.exec(text)
  if (!match) return { error: `无法从内容中解析 ${label}` }
  return { value: match[1] }
}

/**
 * 校验 create-extension/uex 注入的 SDK 版本常量与本次发布版本一致。
 * apiVersion / uexVersion 传 null 表示本次不发布该包、跳过对应校验。
 * 返回错误文案列表（含文件名 + 常量名 + 期望值）。
 */
export function checkVersionConstants({ sdkVersionsText, sdkVersionText, apiVersion, uexVersion }) {
  const errors = []
  if (apiVersion != null) {
    const api = extractString(sdkVersionsText, /extensionApi:\s*'([^']+)'/, 'SDK_VERSIONS.extensionApi')
    if (api.error) errors.push(`create-extension/src/sdkVersions.ts: ${api.error}`)
    else if (api.value !== apiVersion) {
      errors.push(`create-extension/src/sdkVersions.ts 的 SDK_VERSIONS.extensionApi 应为 ${apiVersion}，实际 ${api.value}`)
    }
    const current = extractString(sdkVersionText, /CURRENT_API_VERSION\s*=\s*'([^']+)'/, 'CURRENT_API_VERSION')
    if (current.error) errors.push(`uex/src/lib/sdkVersion.ts: ${current.error}`)
    else if (current.value !== apiVersion) {
      errors.push(`uex/src/lib/sdkVersion.ts 的 CURRENT_API_VERSION 应为 ${apiVersion}，实际 ${current.value}`)
    }
  }
  if (uexVersion != null) {
    const uex = extractString(sdkVersionsText, /uex:\s*'([^']+)'/, 'SDK_VERSIONS.uex')
    if (uex.error) errors.push(`create-extension/src/sdkVersions.ts: ${uex.error}`)
    else if (uex.value !== uexVersion) {
      errors.push(`create-extension/src/sdkVersions.ts 的 SDK_VERSIONS.uex 应为 ${uexVersion}，实际 ${uex.value}`)
    }
  }
  return errors
}

/** git tag 名：`${shortName}@${version}`（不带 scope，与手动手册约定一致）。 */
export function tagName(shortName, version) {
  return `${shortName}@${version}`
}

/**
 * 校验 npm 上已发布包的依赖表：无 workspace: / catalog: 协议残留；
 * @universe-editor/* 互赖必须是 workspaceVersions 里的精确版本。
 */
export function verifyPublishedDeps(deps, workspaceVersions) {
  const errors = []
  for (const [depName, spec] of Object.entries(deps ?? {})) {
    if (spec.startsWith('workspace:') || spec.startsWith('catalog:')) {
      errors.push(`${depName}: 依赖残留 ${spec}（协议未被替换为真实版本）`)
    }
    if (depName in workspaceVersions && spec !== workspaceVersions[depName]) {
      errors.push(`${depName}: 应为精确版本 ${workspaceVersions[depName]}，实际 ${spec}`)
    }
  }
  return errors
}

const GALLERY_ENV_KEYS = ['UE_RELEASE_HOST', 'UE_RELEASE_USER', 'UE_GALLERY_DIR']

/**
 * 内网同步配置自诊断：三变量齐备返回 null，否则返回多行错误消息。
 * 纯函数无 fs 访问；envFileNames 传仓库根文件名列表（过滤与否均可，内部按正则匹配候选 mode）。
 */
export function galleryConfigIssue({ env, mode, explicit, envFileNames }) {
  const missing = GALLERY_ENV_KEYS.filter((key) => !env[key])
  if (missing.length === 0) return null
  const lines = [`内网同步缺少环境变量: ${missing.join(' / ')}（或用 --no-gallery 跳过）`]
  if (!explicit) {
    const candidates = []
    for (const name of envFileNames) {
      const match = /^\.env\.([a-z0-9-]+)$/.exec(name)
      if (match && match[1] !== 'example' && match[1] !== 'local') candidates.push(match[1])
    }
    if (candidates.length > 0) {
      lines.push(
        `当前 mode=${mode}（未显式指定）；检测到 ${candidates
          .map((c) => `.env.${c}`)
          .join(' / ')}，若配置在其中，用 --env <mode> 重跑，如: pnpm ext-packages:publish -- --env ${candidates[0]}`,
      )
    }
  }
  return lines.join('\n')
}
