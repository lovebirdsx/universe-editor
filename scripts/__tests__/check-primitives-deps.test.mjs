/*---------------------------------------------------------------------------------------------
 *  Tests for scripts/check-primitives-deps.mjs. Run with `node --test`.
 *  覆盖：node 内置（node: 前缀与裸名）、electron、其它 workspace 包、未声明裸说明符、
 *  dependencies 非空、注释剥离、豁免标记、包目录缺失、幂等。
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkPrimitivesDeps } from '../check-primitives-deps.mjs'
import { mkTempDir } from '../lib/temp-root.mjs'

/** 造一个只有 packages/primitives 的仓库根；source 为 src/index.ts 内容。 */
function makeRepo({ source = 'export const x = 1\n', manifest } = {}) {
  const root = mkTempDir('ue-primitives-deps-')
  const pkgDir = join(root, 'packages', 'primitives')
  mkdirSync(join(pkgDir, 'src'), { recursive: true })
  writeFileSync(join(pkgDir, 'src', 'index.ts'), source)
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify(manifest ?? { name: '@universe-editor/primitives', type: 'module' }, null, 2),
  )
  return root
}

function importOf(specifier) {
  return `import { x } from '${specifier}'\nexport const y = x\n`
}

function writeFile(root, rel, content) {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

test('零依赖：相对导入与自身子路径不报', () => {
  const root = makeRepo({
    source:
      "import { a } from './uri.js'\nimport type { B } from './types.js'\n" +
      "import { c } from '@universe-editor/primitives/testing'\n" +
      'export * from "./path.js"\nconst d = await import("./lazy.js")\n',
  })
  const { scanned, violations } = checkPrimitivesDeps({ repoRoot: root })
  assert.equal(scanned, 1)
  assert.deepEqual(violations, [])
})

test('裸 node 内置名（含子路径）被判定', () => {
  for (const spec of ['fs', 'path', 'node:fs', 'node:path', 'fs/promises', 'node:assert/strict']) {
    const root = makeRepo({ source: importOf(spec) })
    const { violations } = checkPrimitivesDeps({ repoRoot: root })
    assert.equal(violations.length, 1, `${spec} 应命中`)
    assert.equal(violations[0].file, 'packages/primitives/src/index.ts')
    assert.equal(violations[0].line, 1)
    assert.match(violations[0].reason, /node 内置模块/)
    assert.equal(violations[0].text, importOf(spec).split('\n')[0])
  }
})

test('electron 被判定（含子路径）', () => {
  for (const spec of ['electron', 'electron/main']) {
    const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source: importOf(spec) }) })
    assert.equal(violations.length, 1)
    assert.equal(violations[0].reason, 'electron')
  }
})

test('其它 workspace 包被判定', () => {
  const { violations } = checkPrimitivesDeps({
    repoRoot: makeRepo({ source: importOf('@universe-editor/platform') }),
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].reason, '其它 workspace 包')
})

test('未声明的裸说明符被判定（dependencies 必须为空）', () => {
  const { violations } = checkPrimitivesDeps({
    repoRoot: makeRepo({ source: importOf('lodash') }),
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].reason, /未声明的裸说明符/)
})

test('import / require / export-from / 动态 import 四种写法都覆盖', () => {
  const source = [
    "import fs from 'node:fs'",
    "const a = require('node:os')",
    "export { b } from 'node:crypto'",
    "const c = await import('node:url')",
  ].join('\n')
  const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source }) })
  assert.deepEqual(
    violations.map((v) => v.line),
    [1, 2, 3, 4],
  )
})

test('注释里的 import 不误报，代码里的行号仍准确', () => {
  const source = [
    '// import fs from "node:fs"',
    '/*',
    "import os from 'node:os'",
    '*/',
    '',
    "import real from 'node:path'",
  ].join('\n')
  const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source }) })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].line, 6)
})

test('primitives-allow 标记豁免该行', () => {
  const source = `import fs from 'node:fs' // primitives-allow\n`
  const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source }) })
  assert.deepEqual(violations, [])
})

test('dependencies 非空被判定，devDependencies 不算', () => {
  const bad = checkPrimitivesDeps({
    repoRoot: makeRepo({ manifest: { name: '@universe-editor/primitives', dependencies: { zod: '^3' } } }),
  })
  assert.equal(bad.violations.length, 1)
  assert.equal(bad.violations[0].file, 'packages/primitives/package.json')
  assert.match(bad.violations[0].reason, /dependencies 必须为空/)

  const ok = checkPrimitivesDeps({
    repoRoot: makeRepo({ manifest: { name: '@universe-editor/primitives', devDependencies: { vitest: '^3' } } }),
  })
  assert.deepEqual(ok.violations, [])

  const empty = checkPrimitivesDeps({
    repoRoot: makeRepo({ manifest: { name: '@universe-editor/primitives', dependencies: {} } }),
  })
  assert.deepEqual(empty.violations, [])
})

test('包目录不存在时报警（改包名不能静默让护栏失效）', () => {
  const root = mkTempDir('ue-primitives-deps-')
  const { violations } = checkPrimitivesDeps({ repoRoot: root })
  assert.equal(violations.length, 1)
  assert.match(violations[0].reason, /包目录不存在/)
})

test('跳过 node_modules / dist', () => {
  const root = makeRepo()
  const pkgDir = join(root, 'packages', 'primitives')
  for (const dir of ['node_modules/dep', 'dist']) {
    mkdirSync(join(pkgDir, dir), { recursive: true })
    writeFileSync(join(pkgDir, dir, 'x.ts'), importOf('node:fs'))
  }
  const { scanned, violations } = checkPrimitivesDeps({ repoRoot: root })
  assert.equal(scanned, 1)
  assert.deepEqual(violations, [])
})

test('devDependencies 只允许 __tests__ 内使用，src 下仍是违规', () => {
  const manifest = { name: '@universe-editor/primitives', devDependencies: { vitest: 'catalog:' } }
  const root = makeRepo({ manifest })
  writeFile(
    root,
    'packages/primitives/src/__tests__/x.test.ts',
    "import { it } from 'vitest'\nimport { a } from 'vitest/config'\n",
  )
  assert.deepEqual(checkPrimitivesDeps({ repoRoot: root }).violations, [])

  writeFile(root, 'packages/primitives/src/index.ts', "import { it } from 'vitest'\n")
  const { violations } = checkPrimitivesDeps({ repoRoot: root })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'packages/primitives/src/index.ts')
  assert.match(violations[0].reason, /未声明的裸说明符/)
})

test('说明符换行到下一行时仍能检出（四种写法，行号指向语句开头）', () => {
  const multiline = [
    "import { a } from\n  'node:fs'",
    "const b = await import(\n  'node:os')",
    "export { c } from\n  'node:crypto'",
    "const d = require(\n  'node:url')",
  ].join('\n')
  const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source: multiline }) })
  assert.deepEqual(
    violations.map((v) => [v.line, v.reason]),
    [
      [1, 'node 内置模块'],
      [3, 'node 内置模块'],
      [5, 'node 内置模块'],
      [7, 'node 内置模块'],
    ],
  )
})

test('句尾 from 后面跟下一行的字符串字面量不误报', () => {
  const source = ["const name = obj.from", "'use strict'", 'export const x = name'].join('\n')
  assert.deepEqual(checkPrimitivesDeps({ repoRoot: makeRepo({ source }) }).violations, [])
})

test('scoped devDependency 在 __tests__ 里放行（别名表按包根名匹配）', () => {
  const manifest = {
    name: '@universe-editor/primitives',
    devDependencies: { '@universe-editor/config-ts': 'workspace:*' },
  }
  const root = makeRepo({ manifest })
  writeFile(
    root,
    'packages/primitives/src/__tests__/tsconfig.test.ts',
    "import { base } from '@universe-editor/config-ts'\nexport const x = base\n",
  )
  assert.deepEqual(checkPrimitivesDeps({ repoRoot: root }).violations, [])
})

test('正则字面量里的 /* 让扫描失真时报错而不是静默放行', () => {
  const source = ["const re = /a\\/*b/", "import x from 'node:fs'", 'export const y = [re, x]'].join(
    '\n',
  )
  const { violations } = checkPrimitivesDeps({ repoRoot: makeRepo({ source }) })
  assert.equal(violations.length, 1)
  assert.match(violations[0].reason, /块注释未闭合/)
})

test('幂等：同一输入两次结果一致', () => {
  const root = makeRepo({ source: importOf('node:fs') })
  assert.deepEqual(checkPrimitivesDeps({ repoRoot: root }), checkPrimitivesDeps({ repoRoot: root }))
})

test('真实仓库通过（护栏对当前源码成立）', () => {
  const { violations } = checkPrimitivesDeps()
  assert.deepEqual(violations, [])
})
