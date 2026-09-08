/*---------------------------------------------------------------------------------------------
 *  scripts/lib/editorBundlePackages.mjs 单测：表健康 / 目录约定 / 各消费方输出快照。
 *
 *  快照断言是有意为之的对齐护栏：表结构或条目变化时必须在此有意识地更新预期值，
 *  防止「改表」被当成无害动作。注意：断言 src 目录存在但**不断言 dist 存在**——
 *  干净 CI 上各包 dist 并不存在（test:release 只 build uex），加 dist 断言会挂 CI。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EDITOR_BUNDLE_PACKAGES,
  aliasMapFor,
  externExcludesFor,
  inputDirsFor,
  optimizeExcludesFor,
  packagesRequiringDist,
  pkgDirFor,
  pkgShortFor,
  srcDirFor,
  tokensCssFile,
} from '../editorBundlePackages.mjs'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')

test('表健康：pkg 无重复、mode 与 target 键合法', () => {
  const seen = new Set()
  for (const entry of EDITOR_BUNDLE_PACKAGES) {
    assert.ok(!seen.has(entry.pkg), `duplicate pkg: ${entry.pkg}`)
    seen.add(entry.pkg)
    for (const key of Object.keys(entry)) {
      if (key === 'pkg') continue
      assert.ok(['main', 'renderer'].includes(key), `${entry.pkg}: bad target key ${key}`)
      assert.ok(['src', 'dist'].includes(entry[key]), `${entry.pkg}.${key}: bad mode ${entry[key]}`)
    }
  }
})

test('目录约定：packages/<short>/package.json 存在且 name === pkg', () => {
  for (const entry of EDITOR_BUNDLE_PACKAGES) {
    const manifest = JSON.parse(readFileSync(resolve(pkgDirFor(entry), 'package.json'), 'utf8'))
    assert.equal(manifest.name, entry.pkg, `dir ${pkgShortFor(entry)} does not host ${entry.pkg}`)
  }
})

test('src 模式项的 src/index.ts 存在', () => {
  for (const entry of EDITOR_BUNDLE_PACKAGES) {
    for (const target of ['main', 'renderer']) {
      if (entry[target] !== 'src') continue
      assert.ok(
        existsSync(resolve(srcDirFor(entry), 'index.ts')),
        `${entry.pkg} (${target}) aliases to a missing src/index.ts`,
      )
    }
  }
})

test('inputDirsFor: main 吃 6 项、renderer 吃 4 项（含 extension-gallery/dist）', () => {
  assert.deepEqual(
    inputDirsFor('main').map((p) => p.slice(REPO_ROOT.length + 1).split(sep).join('/')),
    [
      'packages/platform/src',
      'packages/node-services/src',
      'packages/extensions-common/dist',
      'packages/extension-api/dist',
      'packages/extension-gallery/dist',
      'packages/extension-packaging/dist',
    ],
  )
  assert.deepEqual(
    inputDirsFor('renderer').map((p) => p.slice(REPO_ROOT.length + 1).split(sep).join('/')),
    [
      'packages/platform/src',
      'packages/workbench-ui/src',
      'packages/extensions-common/src',
      'packages/extension-gallery/dist',
    ],
  )
})

test('aliasMapFor / externExcludesFor / optimizeExcludesFor 输出快照', () => {
  const mainAlias = aliasMapFor('main')
  assert.deepEqual(Object.keys(mainAlias), ['@universe-editor/platform', '@universe-editor/node-services'])
  for (const target of Object.values(mainAlias)) {
    assert.ok(target.endsWith(`${sep}src${sep}index.ts`), `alias target not src/index.ts: ${target}`)
  }
  const rendererAlias = aliasMapFor('renderer')
  assert.deepEqual(Object.keys(rendererAlias), [
    '@universe-editor/platform',
    '@universe-editor/workbench-ui',
    '@universe-editor/extensions-common',
  ])
  assert.deepEqual(externExcludesFor('main'), [
    '@universe-editor/platform',
    '@universe-editor/node-services',
    '@universe-editor/extensions-common',
    '@universe-editor/extension-api',
    '@universe-editor/extension-gallery',
    '@universe-editor/extension-packaging',
  ])
  assert.deepEqual(optimizeExcludesFor('renderer'), [
    '@universe-editor/platform',
    '@universe-editor/workbench-ui',
    '@universe-editor/extensions-common',
  ])
})

test('packagesRequiringDist: 除 workbench-ui 外的 6 项', () => {
  assert.deepEqual(
    packagesRequiringDist().map((e) => e.pkg),
    [
      '@universe-editor/platform',
      '@universe-editor/node-services',
      '@universe-editor/extensions-common',
      '@universe-editor/extension-api',
      '@universe-editor/extension-gallery',
      '@universe-editor/extension-packaging',
    ],
  )
})

test('tokensCssFile 指向 workbench-ui 的 tokens.css 且文件存在', () => {
  assert.ok(tokensCssFile().endsWith('packages/workbench-ui/src/theme/tokens.css'.split('/').join(sep)))
  assert.ok(existsSync(tokensCssFile()))
})

test('反漂移守卫：config 与 dev-run 不再手写清单', () => {
  const config = readFileSync(resolve(REPO_ROOT, 'apps/editor/electron.vite.config.ts'), 'utf8')
  // 剥掉行注释：注释里允许提及 @universe-editor/ 包名（如本 config 解释 tokens.css 排序），不计入手写清单。
  const code = config.replace(/^\s*\/\/.*$/gm, '')
  const occurrences = code.match(/@universe-editor\//g) ?? []
  assert.equal(occurrences.length, 1, 'config 里 @universe-editor/ 应只剩 tokens.css 文件粒度 alias 一处')
  assert.ok(
    code.includes("@universe-editor/workbench-ui/tokens.css"),
    '唯一保留的字面量应是 workbench-ui/tokens.css',
  )
  const devRun = readFileSync(resolve(REPO_ROOT, 'apps/editor/scripts/dev-run.mjs'), 'utf8')
  assert.ok(!devRun.includes("'packages/"), 'dev-run.mjs 不应再手写 packages/ 清单字面量')
})
