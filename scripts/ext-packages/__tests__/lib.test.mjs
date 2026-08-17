/*---------------------------------------------------------------------------------------------
 *  scripts/ext-packages 纯逻辑单测。Run with `node --test`.
 *  覆盖：版本比较、包选择、拓扑排序、发布计划、依赖完整性、白名单判定、
 *        pack 清单解析/校验、COMPATIBILITY/版本常量校验、协议替换校验、共享清单防线。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK_PACKAGE_DIRS } from '../../lib/sdk-packages.mjs'
import {
  apiVersionConstantMatches,
  assessExternalDeps,
  checkPackListing,
  checkVersionConstants,
  compareVersions,
  galleryConfigIssue,
  hasCompatibilityEntry,
  loadPackageManifests,
  parsePackListing,
  parseWorkspaceSpec,
  planExternalDepQueries,
  planPublish,
  selectPackages,
  tagName,
  topologicalOrder,
  unexpectedChanges,
  verifyPublishedDeps,
} from '../lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')

/** 按目录名构造一个包条目（manifest 依赖可注入）。 */
function pkg(shortName, dependencies = {}) {
  return {
    dir: `packages/${shortName}`,
    shortName,
    name: `@universe-editor/${shortName}`,
    version: '0.1.0',
    manifest: { name: `@universe-editor/${shortName}`, version: '0.1.0', dependencies },
  }
}

const sdk7 = [
  pkg('extension-api', { 'vscode-languageserver-types': 'catalog:' }),
  pkg('extension-manifest', { zod: 'catalog:' }),
  pkg('extension-packaging', {
    '@universe-editor/extension-manifest': 'workspace:*',
    'adm-zip': 'catalog:',
  }),
  pkg('uex', {
    '@universe-editor/extension-manifest': 'workspace:*',
    '@universe-editor/extension-packaging': 'workspace:*',
  }),
  pkg('create-extension', { '@clack/prompts': 'catalog:' }),
  pkg('e2e-contract'),
  pkg('e2e-harness', { '@universe-editor/e2e-contract': 'workspace:*' }),
]

test('compareVersions 大小比较与非法版本', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.throws(() => compareVersions('0.1', '0.1.0'), /X\.Y\.Z/)
  assert.throws(() => compareVersions('v0.1.0', '0.1.0'), /X\.Y\.Z/)
})

test('loadPackageManifests 读取真实 7 件套清单', () => {
  const all = loadPackageManifests(repoRoot, SDK_PACKAGE_DIRS)
  assert.equal(all.length, 7)
  for (const p of all) {
    assert.equal(p.name, `@universe-editor/${p.shortName}`)
    assert.match(p.version, /^\d+\.\d+\.\d+$/)
  }
})

test('selectPackages 无参全选、按目录名/包名选择、未命中报错', () => {
  assert.equal(selectPackages(sdk7, []).selected.length, 7)
  assert.deepEqual(
    selectPackages(sdk7, ['uex']).selected.map((p) => p.shortName),
    ['uex'],
  )
  assert.deepEqual(
    selectPackages(sdk7, ['@universe-editor/extension-manifest']).selected.map((p) => p.shortName),
    ['extension-manifest'],
  )
  const err = selectPackages(sdk7, ['nope'])
  assert.match(err.error, /未找到可发布包: nope/)
})

test('topologicalOrder 7 件套拓扑正确（依赖先于被依赖）', () => {
  const { order, error } = topologicalOrder(sdk7)
  assert.equal(error, undefined)
  const shorts = order.map((p) => p.shortName)
  assert.deepEqual(new Set(shorts), new Set(['extension-api', 'extension-manifest', 'extension-packaging', 'uex', 'create-extension', 'e2e-contract', 'e2e-harness']))
  assert.ok(shorts.indexOf('extension-manifest') < shorts.indexOf('extension-packaging'))
  assert.ok(shorts.indexOf('extension-packaging') < shorts.indexOf('uex'))
  assert.ok(shorts.indexOf('e2e-contract') < shorts.indexOf('e2e-harness'))
})

test('topologicalOrder 忽略集合外依赖与 catalog 依赖', () => {
  const subset = [pkg('uex', { '@universe-editor/extension-manifest': 'workspace:*', zod: 'catalog:' })]
  const { order } = topologicalOrder(subset)
  assert.deepEqual(
    order.map((p) => p.shortName),
    ['uex'],
  )
})

test('topologicalOrder 检测依赖环', () => {
  const a = pkg('a', { '@universe-editor/b': 'workspace:*' })
  const b = pkg('b', { '@universe-editor/a': 'workspace:*' })
  const { error } = topologicalOrder([a, b])
  assert.match(error, /依赖环/)
})

test('parseWorkspaceSpec 识别 workspace 协议', () => {
  assert.deepEqual(parseWorkspaceSpec('workspace:*'), { protocol: '*' })
  assert.deepEqual(parseWorkspaceSpec('workspace:^'), { protocol: '^' })
  assert.deepEqual(parseWorkspaceSpec('workspace:~'), { protocol: '~' })
  assert.equal(parseWorkspaceSpec('catalog:'), null)
  assert.equal(parseWorkspaceSpec('^1.0.0'), null)
  assert.equal(parseWorkspaceSpec(undefined), null)
})

test('planPublish 未发布/更高发、相同跳、更低抛错', () => {
  const selected = [pkg('a'), pkg('b'), pkg('c')]
  selected[0].version = '0.1.0'
  selected[1].version = '0.2.0'
  selected[2].version = '0.1.0'
  const { toPublish, skipped } = planPublish(selected, { a: null, b: '0.1.0', c: '0.1.0' })
  assert.deepEqual(
    toPublish.map((p) => p.shortName),
    ['a', 'b'],
  )
  assert.deepEqual(
    skipped.map((p) => p.shortName),
    ['c'],
  )
  assert.throws(() => planPublish(selected, { a: null, b: '0.3.0', c: '0.1.0' }), /禁止发布旧版本/)
})

test('planExternalDepQueries 集合内免查、集合外查询、非 SDK 集合报错', () => {
  const selected = [
    pkg('uex', {
      '@universe-editor/extension-manifest': 'workspace:*',
      '@universe-editor/extension-packaging': 'workspace:*',
    }),
    pkg('extension-manifest', { zod: 'catalog:' }),
  ]
  const sdkVersionMap = {
    'extension-api': '0.12.0',
    'extension-manifest': '0.2.0',
    'extension-packaging': '0.2.0',
    uex: '0.1.0',
    'create-extension': '0.1.0',
    'e2e-contract': '0.1.0',
    'e2e-harness': '0.1.0',
  }
  // manifest 在 selected 集合内 → 免查；packaging 在集合外 → 查询
  const { queries, errors } = planExternalDepQueries(selected, sdkVersionMap)
  assert.deepEqual(errors, [])
  assert.deepEqual(queries, [
    {
      shortName: 'uex',
      name: '@universe-editor/uex',
      depName: '@universe-editor/extension-packaging',
      targetShort: 'extension-packaging',
      targetVersion: '0.2.0',
    },
  ])
})

test('planExternalDepQueries 依赖 SDK 集合外 workspace 包直接报错', () => {
  const selected = [pkg('uex', { '@universe-editor/extensions-common': 'workspace:*' })]
  const { errors } = planExternalDepQueries(selected, { uex: '0.1.0' })
  assert.match(errors[0], /SDK 集合外的 workspace 包/)
})

test('assessExternalDeps 未发布 → 错误，已发布 → 通过', () => {
  const queries = [
    { name: '@universe-editor/uex', depName: '@universe-editor/extension-packaging', targetVersion: '0.2.0' },
  ]
  assert.deepEqual(
    assessExternalDeps(queries, { '@universe-editor/extension-packaging@0.2.0': 'missing' }),
    ['@universe-editor/uex 依赖的 @universe-editor/extension-packaging@0.2.0 未在 npm 发布；先发布依赖包或将其加入本次发布集合'],
  )
  assert.deepEqual(assessExternalDeps(queries, { '@universe-editor/extension-packaging@0.2.0': 'published' }), [])
})

test('unexpectedChanges 白名单内放行、外拦截、rename 两侧都判定', () => {
  const dirs = ['packages/uex', 'packages/extension-api']
  const lines = [
    ' M packages/uex/package.json',
    '?? packages/uex/new.ts',
    ' M apps/editor/package.json',
    'R  packages/uex/a.ts -> packages/uex/b.ts',
    'R  packages/uex/a.ts -> extensions/typescript/x.ts',
  ]
  assert.deepEqual(unexpectedChanges(lines, dirs), [' M apps/editor/package.json', 'R  packages/uex/a.ts -> extensions/typescript/x.ts'])
  assert.deepEqual(unexpectedChanges([' M packages/uex/a.ts'], dirs), [])
})

test('parsePackListing 提取 Contents/Details 间文件清单', () => {
  const stdout = [
    'package: @universe-editor/extension-manifest@0.1.0',
    'Tarball Contents',
    'dist/index.js',
    'LICENSE',
    'README.md',
    'Tarball Details',
    'universe-editor-extension-manifest-0.1.0.tgz',
  ].join('\n')
  assert.deepEqual(parsePackListing(stdout).files, ['dist/index.js', 'LICENSE', 'README.md'])
})

test('parsePackListing 缺段报错', () => {
  assert.match(parsePackListing('no listing here').error, /缺少 Tarball Contents\/Details 段/)
})

test('checkPackListing 各项硬性校验', () => {
  const good = ['dist/index.js', 'LICENSE', 'README.md']
  assert.deepEqual(checkPackListing(good), [])
  assert.deepEqual(checkPackListing([...good, 'dist/__tests__/x.test.js']), ['pack 内容含 dist/__tests__/'])
  assert.match(checkPackListing(['dist/index.js', 'README.md']).join('\n'), /缺少 LICENSE/)
  assert.match(checkPackListing(['dist/index.js', 'LICENSE']).join('\n'), /缺少 README.md/)
  assert.match(checkPackListing(good, { isBin: true }).join('\n'), /缺少 bin 入口 dist\/cli.js/)
  assert.deepEqual(checkPackListing([...good, 'dist/cli.js'], { isBin: true }), [])
  assert.match(checkPackListing(good, { hasTemplates: true }).join('\n'), /缺少 templates\//)
  assert.deepEqual(checkPackListing([...good, 'templates/basic/index.ts'], { hasTemplates: true }), [])
})

test('hasCompatibilityEntry 命中与版本号转义', () => {
  const text = ['- `0.12.0` — 向后兼容的新增（minor）：Tree View 表面。', '- `0.12.10` — 后续版本。'].join('\n')
  assert.equal(hasCompatibilityEntry(text, '0.12.0'), true)
  assert.equal(hasCompatibilityEntry(text, '0.12.1'), false)
  assert.equal(hasCompatibilityEntry(text, '0.13.0'), false)
})

test('apiVersionConstantMatches 精确匹配', () => {
  const text = "export const version = '0.12.0'\n"
  assert.equal(apiVersionConstantMatches(text, '0.12.0'), true)
  assert.equal(apiVersionConstantMatches(text, '0.12.1'), false)
})

test('checkVersionConstants 全一致通过、漂移报错含期望值', () => {
  const sdkVersionsText = "extensionApi: '0.12.0',\n  uex: '0.1.0',"
  const sdkVersionText = "export const CURRENT_API_VERSION = '0.12.0'"
  assert.deepEqual(
    checkVersionConstants({ sdkVersionsText, sdkVersionText, apiVersion: '0.12.0', uexVersion: '0.1.0' }),
    [],
  )
  const apiDrift = checkVersionConstants({ sdkVersionsText, sdkVersionText, apiVersion: '0.13.0', uexVersion: null })
  assert.match(apiDrift.join('\n'), /SDK_VERSIONS\.extensionApi 应为 0\.13\.0/)
  assert.match(apiDrift.join('\n'), /CURRENT_API_VERSION 应为 0\.13\.0/)
  const uexDrift = checkVersionConstants({ sdkVersionsText, sdkVersionText, apiVersion: null, uexVersion: '0.2.0' })
  assert.match(uexDrift.join('\n'), /SDK_VERSIONS\.uex 应为 0\.2\.0/)
  // 都不发布 → 不校验任何常量
  assert.deepEqual(checkVersionConstants({ sdkVersionsText, sdkVersionText, apiVersion: null, uexVersion: null }), [])
})

test('tagName 不带 scope', () => {
  assert.equal(tagName('extension-api', '0.12.0'), 'extension-api@0.12.0')
})

test('verifyPublishedDeps 协议残留与精确版本校验', () => {
  const workspaceVersions = { '@universe-editor/extension-manifest': '0.1.0' }
  assert.deepEqual(verifyPublishedDeps({ 'vscode-languageserver-types': '^3.17.5' }, workspaceVersions), [])
  assert.deepEqual(verifyPublishedDeps(undefined, workspaceVersions), [])
  const leftover = verifyPublishedDeps({ '@universe-editor/extension-manifest': 'workspace:*' }, workspaceVersions)
  assert.match(leftover.join('\n'), /workspace:\*/)
  const catalog = verifyPublishedDeps({ zod: 'catalog:' }, workspaceVersions)
  assert.match(catalog.join('\n'), /catalog:/)
  const mismatch = verifyPublishedDeps({ '@universe-editor/extension-manifest': '^0.1.0' }, workspaceVersions)
  assert.match(mismatch.join('\n'), /应为精确版本 0\.1\.0/)
})

test('共享清单防线：7 件套、拓扑合法、publish-sdk.mjs 引用共享常量', () => {
  assert.deepEqual(SDK_PACKAGE_DIRS, [
    'packages/extension-api',
    'packages/extension-manifest',
    'packages/extension-packaging',
    'packages/uex',
    'packages/create-extension',
    'packages/e2e-contract',
    'packages/e2e-harness',
  ])
  const all = loadPackageManifests(repoRoot, SDK_PACKAGE_DIRS)
  const { error } = topologicalOrder(all)
  assert.equal(error, undefined)
  const publishSdkText = readFileSync(join(repoRoot, 'scripts/gallery/publish-sdk.mjs'), 'utf8')
  assert.match(publishSdkText, /SDK_PACKAGE_DIRS/, 'publish-sdk.mjs 应引用共享清单而非本地副本')
  assert.doesNotMatch(publishSdkText, /SDK_PACKAGES\s*=/, 'publish-sdk.mjs 不应保留本地清单副本')
})

const FULL_GALLERY_ENV = { UE_RELEASE_HOST: 'h', UE_RELEASE_USER: 'u', UE_GALLERY_DIR: 'd' }

test('galleryConfigIssue: 三变量齐备返回 null', () => {
  assert.equal(galleryConfigIssue({ env: FULL_GALLERY_ENV, mode: 'dev', explicit: false, envFileNames: [] }), null)
})

test('galleryConfigIssue: 缺一个/缺多个 → 第一行只列缺失项，含 --no-gallery 提示', () => {
  const one = galleryConfigIssue({
    env: { UE_RELEASE_HOST: 'h', UE_RELEASE_USER: 'u' },
    mode: 'dev',
    explicit: false,
    envFileNames: [],
  })
  assert.equal(one.split('\n')[0], '内网同步缺少环境变量: UE_GALLERY_DIR（或用 --no-gallery 跳过）')
  assert.doesNotMatch(one.split('\n')[0], /UE_RELEASE_HOST/)
  const many = galleryConfigIssue({ env: {}, mode: 'dev', explicit: false, envFileNames: [] })
  assert.equal(
    many.split('\n')[0],
    '内网同步缺少环境变量: UE_RELEASE_HOST / UE_RELEASE_USER / UE_GALLERY_DIR（或用 --no-gallery 跳过）',
  )
})

test('galleryConfigIssue: 空字符串视作缺失', () => {
  const issue = galleryConfigIssue({
    env: { UE_RELEASE_HOST: '', UE_RELEASE_USER: 'u', UE_GALLERY_DIR: 'd' },
    mode: 'dev',
    explicit: false,
    envFileNames: [],
  })
  assert.equal(issue.split('\n')[0], '内网同步缺少环境变量: UE_RELEASE_HOST（或用 --no-gallery 跳过）')
})

test('galleryConfigIssue: explicit=false 候选只出 prod/win，示例用 --env prod', () => {
  const issue = galleryConfigIssue({
    env: {},
    mode: 'dev',
    explicit: false,
    envFileNames: ['.env.example', '.env.local', '.env.prod', '.env.prod.local', '.env.win'],
  })
  const [first, hint] = issue.split('\n')
  assert.match(first, /内网同步缺少环境变量/)
  assert.match(hint, /当前 mode=dev（未显式指定）/)
  assert.match(hint, /检测到 \.env\.prod \/ \.env\.win/)
  assert.doesNotMatch(hint, /\.env\.example/)
  assert.doesNotMatch(hint, /\.env\.local/)
  assert.match(hint, /pnpm ext-packages:publish -- --env prod$/)
})

test('galleryConfigIssue: explicit=true 无候选提示行', () => {
  const issue = galleryConfigIssue({
    env: {},
    mode: 'prod',
    explicit: true,
    envFileNames: ['.env.prod', '.env.win'],
  })
  assert.equal(issue.split('\n').length, 1)
  assert.doesNotMatch(issue, /检测到/)
})

test('galleryConfigIssue: explicit=false 但无候选文件 → 只有第一行', () => {
  const issue = galleryConfigIssue({
    env: {},
    mode: 'dev',
    explicit: false,
    envFileNames: ['.env.example', '.env.local'],
  })
  assert.equal(issue.split('\n').length, 1)
})
