/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  打进 editor 构建产物的 workspace 包清单——单一真相。
 *
 *  消费方（electron.vite.config.ts / apps/editor/scripts/dev-run.mjs /
 *  scripts/dev/ensure-workspace-build.mjs）的 alias、externalizeDeps.exclude、
 *  optimizeDeps.exclude、按端指纹输入清单、dist 存在性检查全部从此表生成，
 *  禁止再手写任何一份清单：新增/调整打进 bundle 的包只需改下表一行。
 *
 *  mode: 'src'  = 该端 alias 指向 src/index.ts（指纹吃 src 目录）；
 *        'dist' = 该端经 node_modules 解析（指纹吃 dist 目录）。
 *
 *  关键实现约束：REPO_ROOT 必须用 fileURLToPath(import.meta.url) 解析——electron-vite 的
 *  bundleConfigFile 只对 import.meta.url/__dirname/__filename 按真实磁盘路径注入，
 *  import.meta.dirname 会指向临时 bundle 目录。本模块只 import node builtins
 *  （esbuild externalize-deps 会把裸 import 外部化，临时 bundle 加载时才能解析）。
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const EDITOR_BUNDLE_PACKAGES = [
  { pkg: '@universe-editor/platform', main: 'src', renderer: 'src' },
  { pkg: '@universe-editor/node-services', main: 'src' },
  { pkg: '@universe-editor/workbench-ui', renderer: 'src' },
  { pkg: '@universe-editor/extensions-common', main: 'dist', renderer: 'src' },
  { pkg: '@universe-editor/extension-api', main: 'dist' },
  { pkg: '@universe-editor/extension-gallery', main: 'dist', renderer: 'dist' },
  { pkg: '@universe-editor/extension-packaging', main: 'dist' },
]

/** 包名去 `@universe-editor/` 前缀后的短名，约定等于 packages/ 下的目录名（测试锁定）。 */
export function pkgShortFor(entry) {
  return entry.pkg.slice('@universe-editor/'.length)
}

export function pkgDirFor(entry) {
  return resolve(REPO_ROOT, 'packages', pkgShortFor(entry))
}

export function srcDirFor(entry) {
  return join(pkgDirFor(entry), 'src')
}

export function distDirFor(entry) {
  return join(pkgDirFor(entry), 'dist')
}

/** 该端消费此包的方式：'src' / 'dist' / undefined（不消费）。 */
export function modeFor(entry, target) {
  return entry[target]
}

/** 该端对此包打的指纹输入目录（src 模式吃 src、dist 模式吃 dist）。 */
export function inputDirFor(entry, target) {
  return modeFor(entry, target) === 'dist' ? distDirFor(entry) : srcDirFor(entry)
}

/** 按表序的该端指纹输入目录（绝对路径）。每次调用返回新数组。 */
export function inputDirsFor(target) {
  return EDITOR_BUNDLE_PACKAGES.filter((e) => modeFor(e, target) !== undefined).map((e) =>
    inputDirFor(e, target),
  )
}

/** 该端 alias 表：src 模式项 → { pkg: <abs>/src/index.ts }。每次调用返回新对象。 */
export function aliasMapFor(target) {
  const out = {}
  for (const entry of EDITOR_BUNDLE_PACKAGES) {
    if (modeFor(entry, target) === 'src') out[entry.pkg] = join(srcDirFor(entry), 'index.ts')
  }
  return out
}

/** 该端全部消费项的包名（externalizeDeps.exclude 用）。每次调用返回新数组。 */
export function externExcludesFor(target) {
  return EDITOR_BUNDLE_PACKAGES.filter((e) => modeFor(e, target) !== undefined).map((e) => e.pkg)
}

/** 该端 src 模式项的包名（optimizeDeps.exclude 用——只拦 alias 被 prebundle 截胡）。 */
export function optimizeExcludesFor(target) {
  return EDITOR_BUNDLE_PACKAGES.filter((e) => modeFor(e, target) === 'src').map((e) => e.pkg)
}

/**
 * 干净 checkout 后首次 electron-vite 运行前 dist/index.js 必须存在的包：
 * dist 模式项（构建时从 dist 内联）+ 所有 main-targeted 项（extension-host bootstrap
 * 与内置扩展的 esbuild 会内联 platform/extensions-common 等的 dist）。
 * workbench-ui 不在其中——仅 renderer src 消费，无 dist 需求。
 */
export function packagesRequiringDist() {
  return EDITOR_BUNDLE_PACKAGES.filter((e) => e.main !== undefined || e.renderer === 'dist')
}

/** workbench-ui 的 tokens.css 文件粒度 alias 目标（config 里唯一保留的字面量 alias）。 */
export function tokensCssFile() {
  const workbench = EDITOR_BUNDLE_PACKAGES.find((e) => e.pkg === '@universe-editor/workbench-ui')
  return join(srcDirFor(workbench), 'theme', 'tokens.css')
}
