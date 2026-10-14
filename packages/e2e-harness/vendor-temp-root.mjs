/*---------------------------------------------------------------------------------------------
 *  把 @universe-editor/temp-root 的产物 vendor 进 dist/vendor/temp-root/，并把 dist 里对它的
 *  引用改写成相对路径。
 *
 *  该包是私有 workspace 包（0.0.0）且不在 SDK 发布集合内：dependencies 里留 workspace:* 会让
 *  外部消费者解析到未发布的版本号。改写必须同时覆盖 .js 与 .d.ts——只改 JS 的话，消费方
 *  tsconfig 在类型层仍会撞上同一个解析不到的模块。temp-root 零递归依赖（只 import node: 内置
 *  模块），复制 index.js/index.d.ts 即可；不走 esbuild 打包（那条路线不产出 .d.ts）。
 *--------------------------------------------------------------------------------------------*/
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const sourceDir = resolve(packageRoot, '..', 'temp-root', 'dist')
const distDir = join(packageRoot, 'dist')
const vendorDir = join(distDir, 'vendor', 'temp-root')
const VENDORED_FILES = ['index.js', 'index.d.ts']
const MODULE_ID = '@universe-editor/temp-root'
const SPECIFIER_RE = /from\s+'@universe-editor\/temp-root'/g

const missing = VENDORED_FILES.map((f) => join(sourceDir, f)).filter((f) => !existsSync(f))
if (missing.length > 0) {
  console.error(
    `[vendor-temp-root] 缺少 ${missing.join(', ')}，请先构建 @universe-editor/temp-root`,
  )
  process.exit(1)
}

rmSync(vendorDir, { recursive: true, force: true })
mkdirSync(vendorDir, { recursive: true })
for (const file of VENDORED_FILES) copyFileSync(join(sourceDir, file), join(vendorDir, file))

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) yield path
  }
}

const entryPoint = join(vendorDir, 'index.js')
let rewritten = 0
for (const file of walk(distDir)) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes(MODULE_ID)) continue
  const target = relative(dirname(file), entryPoint).split(sep).join('/')
  const next = text.replace(
    SPECIFIER_RE,
    `from '${target.startsWith('.') ? target : `./${target}`}'`,
  )
  if (next === text) continue
  writeFileSync(file, next)
  rewritten += 1
}
console.log(`[vendor-temp-root] 已输出 dist/vendor/temp-root/，改写 ${rewritten} 个文件的模块引用`)
