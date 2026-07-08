/*---------------------------------------------------------------------------------------------
 *  扩展市场运维脚本的共用逻辑：读 VSIX、抽资产、维护 registry.json。
 *
 *  零 npm 依赖（adm-zip 从 packages/extension-packaging 解析，与 extensions-external/pdf 的
 *  pack.mjs 同范式，避免脚本目录自带 node_modules）。registry / VSIX 是市场后端的唯一真相源，
 *  服务端 server.mjs 据 registry.json 生成 /extensionquery 响应，客户端下载 VSIX 后会校验包内
 *  publisher.name.version 与市场元数据一致（防投毒）——故这里的元数据全部从 VSIX 内抽取，杜绝漂移。
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(__dirname, '..', '..')

// adm-zip 随 extension-packaging 安装，从那儿解析（脚本目录本身无 node_modules）。
const require = createRequire(resolve(repoRoot, 'packages/extension-packaging/package.json'))
const AdmZip = require('adm-zip')

const EXTENSION_PREFIX = 'extension/'

/** 读并解析 VSIX 内 extension/package.json；缺失或不可解析则抛错。 */
export function readVsixManifest(vsixPath) {
  const zip = new AdmZip(vsixPath)
  const entry = zip.getEntry(`${EXTENSION_PREFIX}package.json`)
  if (!entry) throw new Error(`invalid VSIX: 缺少 ${EXTENSION_PREFIX}package.json (${vsixPath})`)
  try {
    return JSON.parse(entry.getData().toString('utf8'))
  } catch (err) {
    throw new Error(`invalid VSIX: package.json 不可解析 (${err.message})`)
  }
}

/** 取 VSIX 内某个 extension/ 下文件的内容 Buffer，不存在返回 null。 */
export function readVsixEntry(vsixPath, relative) {
  const zip = new AdmZip(vsixPath)
  const entry = zip.getEntry(`${EXTENSION_PREFIX}${relative}`)
  return entry ? entry.getData() : null
}

/** 解析 x.y.z（忽略预发布/build），非法返回 [0,0,0]。 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

/** semver 比较：a<b → -1，a>b → 1，相等 → 0。 */
export function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1
  }
  return 0
}

/** 从 manifest 抽出 registry 需要的市场元数据。publisher 必填（防投毒依赖）。 */
export function metadataFromManifest(manifest) {
  const publisher = manifest.publisher
  const name = manifest.name
  if (!publisher) throw new Error(`扩展 ${name ?? '?'} 缺少 publisher（市场安装要求发布者必填）`)
  if (!name) throw new Error('VSIX package.json 缺少 name')
  if (!manifest.version) throw new Error(`扩展 ${publisher}.${name} 缺少 version`)
  const engine = manifest.engines?.universe
  if (!engine) throw new Error(`扩展 ${publisher}.${name} 缺少 engines.universe`)
  return {
    publisher,
    name,
    displayName: manifest.displayName ?? name,
    shortDescription: manifest.description ?? '',
    ...(Array.isArray(manifest.categories) ? { categories: manifest.categories } : {}),
    version: manifest.version,
    engine,
    ...(manifest.icon ? { iconRel: manifest.icon } : {}),
  }
}

export function readRegistry(stageDir) {
  const file = resolve(stageDir, 'gallery', 'registry.json')
  if (!existsSync(file)) return { extensions: [] }
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(reg.extensions)) reg.extensions = []
    return reg
  } catch (err) {
    throw new Error(`registry.json 不可解析: ${err.message}`)
  }
}

export function writeRegistry(stageDir, registry) {
  const dir = resolve(stageDir, 'gallery')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'registry.json'), JSON.stringify(registry, null, 2) + '\n')
}

/**
 * 把一个版本 upsert 进 registry（纯数据变换，不落盘）。
 * - 同 publisher.name.version 存在 → 覆盖（重发）。
 * - 新版本 → 加入后按 semver 降序排序，保证 versions[0] 为最新。
 * 返回 { registry, warnings }。
 */
export function upsertVersion(registry, meta, versionEntry) {
  const warnings = []
  const extensions = registry.extensions
  let ext = extensions.find((e) => e.publisher === meta.publisher && e.name === meta.name)
  if (!ext) {
    ext = { publisher: meta.publisher, name: meta.name, versions: [] }
    extensions.push(ext)
  }
  // 扩展级元数据用最新发布覆盖（displayName 等可能随版本变化）。
  ext.displayName = meta.displayName
  ext.shortDescription = meta.shortDescription
  if (meta.categories) ext.categories = meta.categories
  else delete ext.categories

  const existingIdx = ext.versions.findIndex((v) => v.version === versionEntry.version)
  if (existingIdx >= 0) {
    warnings.push(`覆盖已存在版本 ${meta.publisher}.${meta.name}@${versionEntry.version}`)
    ext.versions[existingIdx] = versionEntry
  } else {
    ext.versions.push(versionEntry)
  }
  ext.versions.sort((a, b) => compareVersions(b.version, a.version))
  if (ext.versions[0].version !== versionEntry.version && existingIdx < 0) {
    warnings.push(
      `${meta.publisher}.${meta.name}@${versionEntry.version} 不是最高版本，已按 semver 归位（非首位）`,
    )
  }
  return { registry, warnings }
}

/** 从 registry 移除某扩展（version 省略）或某版本；返回被移除的 assetDir 列表。 */
export function removeFromRegistry(registry, publisher, name, version) {
  const idx = registry.extensions.findIndex((e) => e.publisher === publisher && e.name === name)
  if (idx < 0) return { removedAssetDirs: [], found: false }
  const ext = registry.extensions[idx]
  const removedAssetDirs = []
  if (version) {
    const vIdx = ext.versions.findIndex((v) => v.version === version)
    if (vIdx < 0) return { removedAssetDirs: [], found: false }
    if (ext.versions[vIdx].assetDir) removedAssetDirs.push(ext.versions[vIdx].assetDir)
    ext.versions.splice(vIdx, 1)
    if (ext.versions.length === 0) registry.extensions.splice(idx, 1)
  } else {
    for (const v of ext.versions) if (v.assetDir) removedAssetDirs.push(v.assetDir)
    registry.extensions.splice(idx, 1)
  }
  return { removedAssetDirs, found: true }
}

export { basename }
