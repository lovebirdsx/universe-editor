import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assessVersions,
  buildConfig,
  buildRemoteInstallCommand,
  extractLocalVersion,
  extractRemoteVersion,
  parseArgs,
  sudoersHint,
} from '../deploy.mjs'

test('parseArgs 解析布尔旗标与键值对', () => {
  const args = parseArgs([
    '--env',
    'prod',
    '--dry-run',
    '--yes',
    '--force',
    '--skip-bundle',
    '--host',
    'h1',
  ])
  assert.equal(args.env, 'prod')
  assert.equal(args.dryRun, true)
  assert.equal(args.yes, true)
  assert.equal(args.force, true)
  assert.equal(args.skipBundle, true)
  assert.equal(args.host, 'h1')
})

test('buildConfig 优先级 flag > env > 默认', () => {
  const env = {
    UE_RELEASE_HOST: 'env-host',
    UE_RELEASE_USER: 'env-user',
    UE_RELEASE_PORT: '2222',
  }
  const fromEnv = buildConfig({}, env)
  assert.equal(fromEnv.host, 'env-host')
  assert.equal(fromEnv.user, 'env-user')
  assert.equal(fromEnv.port, '2222')
  assert.equal(fromEnv.appDir, '/opt/universe-update-server')
  assert.equal(fromEnv.healthUrl, 'http://env-host/')

  const fromFlags = buildConfig(
    { host: 'flag-host', 'app-dir': '/data/app', 'health-url': 'http://x/' },
    env,
  )
  assert.equal(fromFlags.host, 'flag-host')
  assert.equal(fromFlags.appDir, '/data/app')
  assert.equal(fromFlags.healthUrl, 'http://x/')
})

test('buildConfig 无 host 时 healthUrl 为 undefined', () => {
  assert.equal(buildConfig({}, {}).healthUrl, undefined)
})

test('extractLocalVersion 读取 SERVER_VERSION 声明', () => {
  assert.equal(extractLocalVersion(`const x = 1\nconst SERVER_VERSION = '7'\n`), '7')
  assert.equal(extractLocalVersion(`const SERVER_VERSION = 'abc'`), null)
  assert.equal(extractLocalVersion(''), null)
})

test('extractRemoteVersion 解析健康检查响应', () => {
  assert.equal(extractRemoteVersion('universe-update-server v3 ok\n'), '3')
  assert.equal(extractRemoteVersion('nginx 404'), null)
})

test('assessVersions 四分支判定', () => {
  const unreachable = assessVersions('4', null)
  assert.equal(unreachable.needsForce, false)
  assert.match(unreachable.message, /不可达/)

  const same = assessVersions('4', '4')
  assert.equal(same.needsForce, true)
  assert.match(same.message, /SERVER_VERSION/)

  const downgrade = assessVersions('4', '5')
  assert.equal(downgrade.needsForce, true)
  assert.match(downgrade.message, /降级/)

  const upgrade = assessVersions('4', '3')
  assert.equal(upgrade.needsForce, false)
})

test('buildRemoteInstallCommand 顺序为 cp 成功才 restart，最后清理临时文件', () => {
  const cmd = buildRemoteInstallCommand({ appDir: '/opt/universe-update-server', version: '4' })
  assert.equal(
    cmd,
    'sudo -n cp ~/server.js.v4 /opt/universe-update-server/server.mjs && ' +
      'sudo -n systemctl restart universe-update-server && rm ~/server.js.v4',
  )
})

test('sudoersHint 包含用户与安装目录', () => {
  const hint = sudoersHint('deploy', '/opt/universe-update-server')
  assert.match(hint, /^deploy ALL=\(root\) NOPASSWD: /)
  assert.match(hint, /\/home\/deploy\/server\.js\.v\*/)
  assert.match(hint, /\/opt\/universe-update-server\/server\.mjs/)
  assert.match(hint, /systemctl restart universe-update-server/)
})

const deployScript = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'deploy.mjs')

function runDeploy(args, env = {}) {
  const cleanEnv = { ...process.env, ...env }
  delete cleanEnv.UE_ENV
  return spawnSync(process.execPath, [deployScript, ...args], {
    encoding: 'utf8',
    env: cleanEnv,
    cwd: join(dirname(deployScript), '..', '..'),
  })
}

test('未显式指定 prod 时直接拒绝', () => {
  const res = runDeploy([])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /必须显式指定生产环境/)
})

test('dry-run 全链路只打印命令，零副作用且不触发确认', () => {
  const res = runDeploy([
    '--env=prod',
    '--dry-run',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /\[dry-run\] pnpm server:bundle/)
  assert.match(res.stdout, /\[dry-run\] scp .*server\.js\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] ssh .*sudo -n cp/)
  assert.doesNotMatch(res.stdout, /继续部署\?/)
})
