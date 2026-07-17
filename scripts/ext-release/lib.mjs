/*---------------------------------------------------------------------------------------------
 *  ext-release 的纯逻辑（无副作用，可单测）：发现扩展、可发布性判定、选择、增量判定。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 不可发布的原因（合法则返回 null）。与 gallery 防投毒要求一致。 */
export function ineligibleReason(manifest) {
  if (manifest.private) return 'private'
  if (!manifest.publisher) return '缺少 publisher'
  if (!manifest.name) return '缺少 name'
  if (!manifest.version) return '缺少 version'
  if (!manifest.engines?.universe) return '缺少 engines.universe'
  return null
}

/**
 * 扫 `externalRoot/*`，读 manifest，返回 { eligible[], skipped[] }。
 * eligible 项含 { dir, extDir, manifest, id, version }；skipped 含 { dir, reason }。
 */
export function discoverExtensions(externalRoot) {
  const eligible = []
  const skipped = []
  if (!existsSync(externalRoot)) return { eligible, skipped }
  for (const entry of readdirSync(externalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const extDir = join(externalRoot, entry.name)
    const manifestPath = join(extDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      skipped.push({ dir: entry.name, reason: `package.json 不可解析 (${err.message})` })
      continue
    }
    const reason = ineligibleReason(manifest)
    if (reason) {
      skipped.push({ dir: entry.name, reason })
      continue
    }
    eligible.push({
      dir: entry.name,
      extDir,
      manifest,
      id: `${manifest.publisher}.${manifest.name}`,
      version: manifest.version,
    })
  }
  return { eligible, skipped }
}

/**
 * 位置参数（目录名或 publisher.name）过滤，无参则全选。
 * 未命中返回 { error }，否则 { selected }。
 */
export function selectExtensions(all, selectors) {
  if (selectors.length === 0) return { selected: all }
  const selected = []
  for (const sel of selectors) {
    const match = all.find((e) => e.dir === sel || e.id === sel)
    if (!match) {
      return { error: `未找到可发布扩展: ${sel}（可选: ${all.map((e) => e.dir).join(', ') || '无'}）` }
    }
    selected.push(match)
  }
  return { selected }
}

/** stage registry 是否已含该 publisher.name@version。 */
export function alreadyPublished(registry, ext) {
  const found = registry.extensions.find(
    (e) => e.publisher === ext.manifest.publisher && e.name === ext.manifest.name,
  )
  return !!found?.versions?.some((v) => v.version === ext.version)
}

/** 应用增量判定，返回需要发布的扩展（force=true 则全部）。 */
export function filterIncremental(registry, selected, force) {
  if (force) return { toPublish: selected, skipped: [] }
  const toPublish = []
  const skipped = []
  for (const ext of selected) {
    if (alreadyPublished(registry, ext)) skipped.push(ext)
    else toPublish.push(ext)
  }
  return { toPublish, skipped }
}
