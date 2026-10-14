/*---------------------------------------------------------------------------------------------
 *  scripts/toolchain 纯逻辑单测。Run with `node --test`.
 *  覆盖：SDK 依赖闭包、本地化改写、安装来源断言、CI build filter 与发布集合的同步护栏。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK_PACKAGE_SHORT_NAMES } from '../../lib/sdk-packages.mjs'
import {
  computeSdkClosure,
  findNonLocalSdkInstalls,
  localizeSdkDeps,
  sdkDepNames,
  sdkShortName,
} from '../lib.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const readJson = (rel) => JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'))

const realManifests = () =>
  new Map(SDK_PACKAGE_SHORT_NAMES.map((short) => [short, readJson(`packages/${short}/package.json`)]))

test('sdkShortName 只认本 scope', () => {
  assert.equal(sdkShortName('@universe-editor/uex'), 'uex')
  assert.equal(sdkShortName('zod'), null)
  assert.equal(sdkShortName('@universe-editorx/uex'), null)
})

test('sdkDepNames 默认只取运行期桶，includeDev 才带上 devDependencies', () => {
  const manifest = {
    dependencies: { '@universe-editor/a': '1.0.0', zod: '^4.0.0' },
    peerDependencies: { '@universe-editor/b': '^1.0.0' },
    devDependencies: { '@universe-editor/build-only': 'workspace:*' },
  }
  assert.deepEqual(sdkDepNames(manifest).sort(), ['@universe-editor/a', '@universe-editor/b'])
  assert.deepEqual(sdkDepNames(manifest, { includeDev: true }).sort(), [
    '@universe-editor/a',
    '@universe-editor/b',
    '@universe-editor/build-only',
  ])
})

test('computeSdkClosure 展开传递依赖，不跟随 devDependencies', () => {
  const manifests = new Map([
    [
      'a',
      {
        dependencies: { '@universe-editor/b': 'workspace:*' },
        devDependencies: { '@universe-editor/build-only': 'workspace:*' },
      },
    ],
    ['b', { peerDependencies: { '@universe-editor/c': '^1.0.0' } }],
    ['c', {}],
    ['build-only', {}],
  ])
  const sdkOrder = ['a', 'b', 'c', 'build-only']
  const { closure, errors } = computeSdkClosure({
    roots: ['@universe-editor/a', 'zod', '@universe-editor/a'],
    manifests,
    sdkOrder,
  })
  assert.deepEqual(errors, [])
  // build-only 只在 a 的 devDependencies 里 —— 构建期工具，不进消费者安装树
  assert.deepEqual(closure, ['a', 'b', 'c'])
})

test('computeSdkClosure 按 sdkOrder 输出（发布拓扑序）', () => {
  const manifests = new Map([
    ['leaf', {}],
    ['root', { dependencies: { '@universe-editor/leaf': 'workspace:*' } }],
  ])
  const { closure } = computeSdkClosure({
    roots: ['@universe-editor/root'],
    manifests,
    sdkOrder: ['leaf', 'root'],
  })
  assert.deepEqual(closure, ['leaf', 'root'])
})

test('computeSdkClosure 报出集合外的 @universe-editor 依赖与缺失 manifest', () => {
  const manifests = new Map([['a', { dependencies: { '@universe-editor/outsider': 'workspace:*' } }]])
  const { errors } = computeSdkClosure({
    roots: ['@universe-editor/a', '@universe-editor/no-manifest'],
    manifests,
    sdkOrder: ['a', 'no-manifest'],
  })
  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /outsider/)
  assert.match(errors.join('\n'), /no-manifest/)
})

test('模板依赖闭包（golden：不含 create-extension —— 它以脚手架身份单独安装）', () => {
  const manifests = realManifests()
  for (const template of ['basic', 'webview']) {
    const pkg = readJson(`packages/create-extension/templates/${template}/package.json`)
    const { closure, errors } = computeSdkClosure({
      roots: sdkDepNames(pkg, { includeDev: true }),
      manifests,
      sdkOrder: SDK_PACKAGE_SHORT_NAMES,
    })
    assert.deepEqual(errors, [], `${template}: 闭包出现不可本地化的依赖`)
    assert.deepEqual(
      closure,
      [
        'primitives',
        'extension-api',
        'extension-manifest',
        'extension-packaging',
        'uex',
        'e2e-contract',
        'e2e-harness',
      ],
      `${template}: 闭包漂移 —— 确认新依赖在 SDK_PACKAGE_DIRS 内，并同步 CI build filter`,
    )
  }
})

test('CI 的 toolchain build filter 覆盖整个发布集合', () => {
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const step = /- name: Build toolchain packages\n([\s\S]*?)(?=\n[ \t]*- name:|$)/.exec(ci)
  assert.ok(step, '未在 ci.yml 中找到 Build toolchain packages 步骤')
  // 只认整行就是 filter 的行：注释里提到 --filter 不该算成会被执行的 filter
  const filters = step[1]
    .split('\n')
    .map((line) => /^[ \t]*--filter=@universe-editor\/([a-z0-9-]+)[ \t]*$/.exec(line)?.[1])
    .filter((short) => short !== undefined)
  // assertDist 要求每个 pack 成员的 dist 存在，而 turbo 的 ^build 不会带上没人依赖的 e2e-*
  assert.deepEqual([...filters].sort(), [...SDK_PACKAGE_SHORT_NAMES].sort())
})

test('localizeSdkDeps 改写已声明的、补齐传递依赖', () => {
  const manifest = { devDependencies: { '@universe-editor/uex': '^0.3.3', zod: '^4.0.0' } }
  const tarballs = { uex: '/tmp/uex.tgz', primitives: '/tmp/primitives.tgz' }
  const { added, rewritten, missing } = localizeSdkDeps(
    manifest,
    ['uex', 'primitives', 'absent'],
    tarballs,
  )
  assert.deepEqual(rewritten, ['uex'])
  assert.deepEqual(added, ['primitives'])
  assert.deepEqual(missing, ['absent'])
  assert.equal(manifest.devDependencies['@universe-editor/uex'], 'file:/tmp/uex.tgz')
  assert.equal(manifest.devDependencies['@universe-editor/primitives'], 'file:/tmp/primitives.tgz')
  assert.equal(manifest.devDependencies.zod, '^4.0.0', '非本 scope 的依赖不该被动')
})

test('localizeSdkDeps 漏 tarball 时进 missing 而不是静默跳过', () => {
  const manifest = {}
  const { added, missing } = localizeSdkDeps(manifest, ['uex'], {})
  assert.deepEqual(added, [])
  assert.deepEqual(missing, ['uex'])
  assert.deepEqual(manifest.devDependencies ?? {}, {})
})

test('localizeSdkDeps 改写同名包出现在多个桶时的全部副本', () => {
  const manifest = {
    dependencies: { '@universe-editor/uex': '^0.3.3' },
    devDependencies: { '@universe-editor/uex': '^0.3.3' },
  }
  const { rewritten, added } = localizeSdkDeps(manifest, ['uex'], { uex: '/tmp/uex.tgz' })
  assert.deepEqual(rewritten, ['uex'])
  assert.deepEqual(added, [])
  // npm 对重复声明的取舍与桶顺序无关，只改一个会留下旧 range 被 npm 选中
  assert.equal(manifest.dependencies['@universe-editor/uex'], 'file:/tmp/uex.tgz')
  assert.equal(manifest.devDependencies['@universe-editor/uex'], 'file:/tmp/uex.tgz')
})

test('computeSdkClosure 同一非法依赖经多条路径到达只报一次', () => {
  const manifests = new Map([
    ['a', { dependencies: { '@universe-editor/outsider': 'workspace:*' } }],
    ['b', { dependencies: { '@universe-editor/outsider': 'workspace:*' } }],
  ])
  const { errors } = computeSdkClosure({
    roots: ['@universe-editor/a', '@universe-editor/b', '@universe-editor/outsider'],
    manifests,
    sdkOrder: ['a', 'b'],
  })
  assert.equal(errors.length, 1)
})

test('findNonLocalSdkInstalls 抓 registry 副本（同版本不同来源 = 假绿）', () => {
  const expected = new Map([['@universe-editor/uex', '0.3.3']])
  const issues = findNonLocalSdkInstalls(
    {
      'node_modules/@universe-editor/uex': {
        version: '0.3.3',
        resolved: 'https://registry.npmjs.org/@universe-editor/uex/-/uex-0.3.3.tgz',
      },
    },
    expected,
  )
  assert.equal(issues.length, 1)
  assert.match(issues[0], /resolved/)
})

test('findNonLocalSdkInstalls 抓版本漂移、闭包外副本，放行本地 tarball', () => {
  const expected = new Map([['@universe-editor/uex', '0.3.3']])
  const local = {
    'node_modules/@universe-editor/uex': {
      version: '0.3.3',
      resolved: 'file:/tmp/ue-toolchain-smoke/tarballs/universe-editor-uex-0.3.3.tgz',
    },
  }
  assert.deepEqual(findNonLocalSdkInstalls(local, expected), [])

  const drifted = {
    'node_modules/@universe-editor/uex': { version: '0.3.2', resolved: 'file:/tmp/x/uex.tgz' },
  }
  assert.match(findNonLocalSdkInstalls(drifted, expected)[0], /0\.3\.2/)

  const nested = {
    'node_modules/@universe-editor/uex/node_modules/@universe-editor/temp-root': {
      version: '0.1.0',
      resolved: 'file:/tmp/x/temp-root.tgz',
    },
  }
  assert.match(findNonLocalSdkInstalls(nested, expected).join('\n'), /闭包外/)

  assert.deepEqual(
    findNonLocalSdkInstalls({ 'node_modules/zod': { version: '4.0.0' }, '': {} }, new Map()),
    [],
  )
})

test('findNonLocalSdkInstalls 在 lock 缺记录时报错（证据缺失不等于证据成立）', () => {
  // lockfileVersion 1 没有 packages 映射；此时放行等于静默假绿
  const issues = findNonLocalSdkInstalls({}, new Map([['@universe-editor/uex', '0.3.3']]))
  assert.equal(issues.length, 1)
  assert.match(issues[0], /没有 @universe-editor\/uex 的记录/)
})
