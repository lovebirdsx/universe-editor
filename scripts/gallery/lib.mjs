/*---------------------------------------------------------------------------------------------
 *  扩展市场运维脚本的共用逻辑：读 VSIX、抽资产、维护 registry.json。
 *
 *  adm-zip 经仓库根 package.json 的 devDependency 解析（根 node_modules 对 scripts/ 可见；
 *  服务端 bundle 产物则内联它）。registry / VSIX 是市场后端的唯一真相源，
 *  服务端 server.mjs 据 registry.json 生成 /extensionquery 响应，客户端下载 VSIX 后会校验包内
 *  publisher.name.version 与市场元数据一致（防投毒）——故这里的元数据全部从 VSIX 内抽取，杜绝漂移。
 *--------------------------------------------------------------------------------------------*/

import AdmZip from 'adm-zip'
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(__dirname, '..', '..')

/** 市场签名私钥的默认落盘位置（已 gitignore，绝不提交）。 */
export const DEFAULT_SIGNING_KEY_FILE = resolve(repoRoot, 'market-key.pem')

/**
 * 解析市场签名私钥路径，优先级：--signing-key-file > UE_GALLERY_SIGNING_KEY_FILE >
 * 默认路径（存在才用）。env 显式设为空串可屏蔽默认路径回退（测试/CI 确定性）。
 * 均未命中返回 undefined，由调用方决定报错文案。
 */
export function resolveSigningKeyFile(argValue, envValue, defaultFile = DEFAULT_SIGNING_KEY_FILE) {
  const explicit = argValue ?? envValue ?? process.env.UE_GALLERY_SIGNING_KEY_FILE
  if (explicit !== undefined) return explicit
  return existsSync(defaultFile) ? defaultFile : undefined
}

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

/** 同目录 tmp + rename 原子写 JSON（半写文件不会让读侧落到 fallback 空态）。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = resolve(dirname(file), `.tmp-${randomUUID()}`)
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

export function writeRegistry(stageDir, registry) {
  writeJsonAtomic(resolve(stageDir, 'gallery', 'registry.json'), registry)
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

/**
 * 计算 VSIX 的 sha256 + 市场 Ed25519 签名。签的是文件原始字节（Ed25519 内部已含哈希），
 * 客户端用内置公钥验签（packages/extension-packaging signature.ts），防托管层篡改。
 * privateKey 为 node:crypto KeyObject；keyId 进签名块，供客户端按 id 查公钥（支持轮换）。
 */
export function signVsix(vsixPath, { privateKey, keyId }) {
  const bytes = readFileSync(vsixPath)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, bytes, privateKey).toString('base64'),
    },
  }
}

/** publisher 名合法性（token.mjs 运维签发与注册 API 共用，与 uex login 校验一致）。 */
export const PUBLISHER_RE = /^[a-z0-9][a-z0-9-]*$/
export const PUBLISHER_MAX_LEN = 64

/** 注册 API 需拦截的官方保留名（运维 token.mjs 签发官方名属合法，不拦）。 */
export const RESERVED_PUBLISHERS = new Set([
  'universe',
  'universe-editor',
  'universeeditor',
  'official',
  'admin',
  'administrator',
  'marketplace',
  'gallery',
  'microsoft',
  'vscode',
])

/**
 * publisher 审批状态。缺失视为 active（兼容审批制之前签发的既有记录）；
 * 非法值按 rejected 处理（fail-closed）。
 */
export function publisherStatus(entry) {
  if (entry.status === undefined) return 'active'
  return entry.status === 'active' || entry.status === 'pending' || entry.status === 'rejected'
    ? entry.status
    : 'rejected'
}

/**
 * 签发 publish token（纯数据变换，不落盘）：publisher 不存在则隐式创建；
 * 同 publisher 下已存在未吊销的同 label token 抛错（换 label 或先 revoke）。
 * 明文只返回给调用方这一次，data 里只落 sha256 哈希。
 * 返回 { token, created }，created 标记 publisher 是否为本次新建。
 * 新建的 publisher 记 created 时间戳；status 默认 'active'（运维签发直接可用），
 * 自助注册通道显式传 'pending'（审批制，approve 前 publish/unpublish 403）。
 */
export function issueToken(data, publisher, label, { status = 'active' } = {}) {
  let entry = data.publishers.find((p) => p.name === publisher)
  const created = !entry
  if (!entry) {
    entry = { name: publisher, status, created: new Date().toISOString(), tokens: [] }
    data.publishers.push(entry)
  }
  if (entry.tokens.some((t) => t.label === label && !t.revoked)) {
    throw new Error(`publisher ${publisher} 下已存在未吊销的 label "${label}"（换 label 或先 revoke）`)
  }
  const token = `uet_${randomBytes(24).toString('base64url')}`
  entry.tokens.push({
    hash: createHash('sha256').update(token).digest('hex'),
    label,
    created: new Date().toISOString(),
    revoked: null,
  })
  return { token, created }
}

export { basename }
