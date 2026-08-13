/*---------------------------------------------------------------------------------------------
 *  bundle 的 server.env 生成闸门：.env 只在开发机存在，所以 .env.<mode> → server.env 的转换
 *  固定发生在打包时；服务器侧的 setup 只消费生成物。这里守住"何时生成/何时清理"的语义。
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverDir = join(__dirname, '..')
const repoRoot = join(serverDir, '..', '..')
const bundleScript = join(serverDir, 'bundle.mjs')
// 用独立临时 dist 目录跑 bundle，避免与 setup.test.mjs（操作真实 dist/server.env）并发互踩同一份产物。
const distDir = mkdtempSync(join(tmpdir(), 'ue-bundle-env-'))
const envOutput = join(distDir, 'server.env')

// 独立 mode 名，避免与开发者本机真实的 .env.prod / .env.test 撞车。
const MODE = 'bundletest'
const modeFile = join(repoRoot, `.env.${MODE}`)

function runBundle(args = []) {
  const env = { ...process.env }
  delete env.UE_ENV
  // 清掉外部注入的 UE_SERVER_*，否则本机 shell 环境会盖过 .env 文件（loadEnv 不覆盖已存在的）。
  for (const key of Object.keys(env)) if (key.startsWith('UE_SERVER_')) delete env[key]
  env.UE_SERVER_DIST_DIR = distDir
  return spawnSync(process.execPath, [bundleScript, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
  })
}

after(() => {
  rmSync(modeFile, { force: true })
  rmSync(distDir, { recursive: true, force: true })
})

test('不带 --env 不生成 server.env——默认 mode 是 dev，静默把开发配置打进产物很危险', () => {
  writeFileSync(envOutput, 'UE_SERVER_PORT=1\n')
  const res = runBundle()
  assert.equal(res.status, 0, res.stderr)
  // 且会清理上一次带 --env 留下的陈旧产物，避免被误拷到服务器。
  assert.equal(existsSync(envOutput), false)
  assert.match(res.stdout, /已清理上次生成的/)
})

test('--env <mode> 从 .env.<mode> 生成 server.env，部署侧机密不进产物', () => {
  writeFileSync(
    modeFile,
    [
      'UE_SERVER_ROOT=/srv/bundletest',
      'UE_SERVER_PORT=8123',
      'UE_RELEASE_KEY=/home/me/.ssh/id_ed25519',
      'UE_RELEASE_HOST=10.9.9.9',
    ].join('\n') + '\n',
  )
  const res = runBundle(['--env', MODE])
  assert.equal(res.status, 0, res.stderr)
  assert.ok(existsSync(envOutput), 'dist/server.env 应已生成')

  const text = readFileSync(envOutput, 'utf8')
  assert.match(text, /^UE_SERVER_ROOT=\/srv\/bundletest$/m)
  assert.match(text, /^UE_SERVER_PORT=8123$/m)
  // 只给 root，其余路径跟着派生。
  assert.match(text, /^UE_SERVER_GALLERY_ROOT=\/srv\/bundletest\/gallery$/m)
  // 白名单外的部署侧机密绝不落进随包产物。
  assert.doesNotMatch(text, /UE_RELEASE_KEY|id_ed25519|10\.9\.9\.9/)
})

test('目标平台跟随 .env 里的 Windows 路径：反斜杠默认值 + CRLF 行尾', () => {
  writeFileSync(modeFile, 'UE_SERVER_APP_DIR=C:\\universe-editor\\app\n')
  const res = runBundle(['--env', MODE])
  assert.equal(res.status, 0, res.stderr)

  const text = readFileSync(envOutput, 'utf8')
  assert.match(text, /\r\n/, 'Windows 目标应为 CRLF')
  assert.match(text, /^UE_SERVER_ROOT=C:\\universe-editor\\data\r$/m)
  // UE_SERVER_APP_DIR 是部署侧参数，只用于判定平台，不进 server.env。
  assert.doesNotMatch(text, /UE_SERVER_APP_DIR/)
})
