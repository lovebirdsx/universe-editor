import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assessVersions,
  buildConfig,
  buildRemoteInstallCommand,
  buildServerEnvReadCommand,
  extractLocalVersion,
  extractRemoteVersion,
  isWindowsAppDir,
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
  const cmd = buildRemoteInstallCommand({
    appDir: '/opt/universe-update-server',
    serverRoot: '/srv/universe-editor',
    version: '4',
  })
  assert.equal(
    cmd,
    'sudo -n cp ~/index.html.v4 /srv/universe-editor/index.html && rm ~/index.html.v4 && ' +
      'sudo -n cp ~/server.js.v4 /opt/universe-update-server/server.mjs && ' +
      'sudo -n systemctl restart universe-update-server && rm ~/server.js.v4',
  )
})

test('buildRemoteInstallCommand withEnv：配置先于程序落地，各自成功才继续', () => {
  const cmd = buildRemoteInstallCommand({
    appDir: '/opt/universe-update-server',
    serverRoot: '/srv/universe-editor',
    version: '4',
    withEnv: true,
  })
  assert.equal(
    cmd,
    'sudo -n cp ~/server.env.v4 /opt/universe-update-server/server.env && rm ~/server.env.v4 && ' +
      'sudo -n cp ~/index.html.v4 /srv/universe-editor/index.html && rm ~/index.html.v4 && ' +
      'sudo -n cp ~/server.js.v4 /opt/universe-update-server/server.mjs && ' +
      'sudo -n systemctl restart universe-update-server && rm ~/server.js.v4',
  )
  assert.ok(cmd.indexOf('server.env.v4') < cmd.indexOf('server.js.v4'))
})

test('buildRemoteInstallCommand 把 index.html 落到 UE_SERVER_ROOT（发布根），不是 appDir', () => {
  const cmd = buildRemoteInstallCommand({
    appDir: '/opt/universe-update-server',
    serverRoot: '/data/releases',
    version: '4',
  })
  assert.match(cmd, /sudo -n cp ~\/index\.html\.v4 \/data\/releases\/index\.html/)
  assert.doesNotMatch(cmd, /\/opt\/universe-update-server\/index\.html/)
})

test('isWindowsAppDir 按盘符/反斜杠识别 Windows 路径', () => {
  assert.equal(isWindowsAppDir('C:\\universe-editor\\server'), true)
  assert.equal(isWindowsAppDir('C:/universe-editor/server'), true)
  assert.equal(isWindowsAppDir('D:\\app'), true)
  assert.equal(isWindowsAppDir('/opt/universe-update-server'), false)
  assert.equal(isWindowsAppDir('/data/app'), false)
})

test('buildRemoteInstallCommand Windows 分支：copy 成功才 End+等待+Run，Run 成功才清理', () => {
  const cmd = buildRemoteInstallCommand({
    appDir: 'C:\\universe-editor\\app',
    serverRoot: 'C:\\universe-editor\\data',
    version: '4',
    windows: true,
  })
  assert.equal(
    cmd,
    'copy /Y index.html.v4 "C:\\universe-editor\\data\\index.html" && del index.html.v4 && ' +
      'copy /Y server.js.v4 "C:\\universe-editor\\app\\server.mjs" && ' +
      '(schtasks /End /TN UniverseUpdateServer 2>nul & ping -n 3 127.0.0.1 >nul & ' +
      'schtasks /Run /TN UniverseUpdateServer) && del server.js.v4',
  )
})

test('buildRemoteInstallCommand Windows 分支归一正斜杠与尾部斜杠', () => {
  const cmd = buildRemoteInstallCommand({
    appDir: 'C:/universe-editor/server/',
    serverRoot: 'C:/universe-editor/data/',
    version: '9',
    windows: true,
  })
  assert.match(cmd, /copy \/Y server\.js\.v9 "C:\\universe-editor\\server\\server\.mjs"/)
  assert.match(cmd, /copy \/Y index\.html\.v9 "C:\\universe-editor\\data\\index\.html"/)
})

test('buildRemoteInstallCommand Windows withEnv：server.env 先落地且路径归一', () => {
  const cmd = buildRemoteInstallCommand({
    appDir: 'C:\\universe-editor\\app',
    serverRoot: 'C:\\universe-editor\\data',
    version: '4',
    windows: true,
    withEnv: true,
  })
  assert.match(cmd, /^copy \/Y server\.env\.v4 "C:\\universe-editor\\app\\server\.env" && del /)
  assert.ok(cmd.indexOf('server.env.v4') < cmd.indexOf('server.js.v4'))
})

test('buildServerEnvReadCommand：Linux cat、Windows type 且路径归一成反斜杠', () => {
  assert.equal(
    buildServerEnvReadCommand({ appDir: '/opt/universe-update-server', windows: false }),
    'cat /opt/universe-update-server/server.env',
  )
  assert.equal(
    buildServerEnvReadCommand({ appDir: 'C:/universe-editor/app/', windows: true }),
    'type "C:\\universe-editor\\app\\server.env"',
  )
})

test('sudoersHint 覆盖 server.js、server.env 与 index.html 三条 cp 通道 + true 探测锚点', () => {
  const hint = sudoersHint('deploy', '/opt/universe-update-server', '/srv/universe-editor')
  assert.match(hint, /^deploy ALL=\(root\) NOPASSWD: /)
  assert.match(hint, /\/home\/deploy\/server\.js\.v\*/)
  assert.match(hint, /\/home\/deploy\/server\.env\.v\* \/opt\/universe-update-server\/server\.env/)
  assert.match(hint, /\/home\/deploy\/index\.html\.v\* \/srv\/universe-editor\/index\.html/)
  assert.match(hint, /\/opt\/universe-update-server\/server\.mjs/)
  assert.match(hint, /systemctl restart universe-update-server/)
  // /usr/bin/true 是免密探测锚点：deploy 检查 `sudo -n /usr/bin/true`，缺它命令特定规则下检查必失败
  assert.match(hint, /\/usr\/bin\/true$/)
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

test('未显式指定环境时直接拒绝', () => {
  const res = runDeploy([])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /必须显式指定目标环境/)
})

test('dry-run 全链路只打印命令，零副作用且不触发确认', () => {
  const res = runDeploy([
    '--env=prod',
    '--dry-run',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--app-dir',
    '/opt/universe-update-server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /\[prod\] 部署/)
  assert.match(res.stdout, /\[dry-run\] pnpm server:bundle/)
  assert.match(res.stdout, /\[dry-run\] scp .*server\.js\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] ssh .*sudo -n cp/)
  // 下载页随 deploy 同步：上传 staged 文件，安装时落默认发布根 /srv/universe-editor
  assert.match(res.stdout, /\[dry-run\] scp .*index\.html\.v\d+/)
  assert.match(res.stdout, /sudo -n cp ~\/index\.html\.v\d+ \/srv\/universe-editor\/index\.html/)
  assert.doesNotMatch(res.stdout, /继续部署\?/)
})

test('--env test 也可部署，摘要与命令带上测试环境标识', () => {
  const res = runDeploy([
    '--env',
    'test',
    '--dry-run',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--app-dir',
    '/opt/universe-update-server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /\[test\] 部署/)
  assert.match(res.stdout, /\[dry-run\] pnpm server:bundle/)
  assert.match(res.stdout, /\[dry-run\] scp .*server\.js\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] ssh .*sudo -n cp/)
  assert.doesNotMatch(res.stdout, /继续部署\?/)
})

test('Windows 远端（app-dir 为 Windows 路径）走 schtasks 链路，不再拒绝', () => {
  const res = runDeploy([
    '--env',
    'test',
    '--dry-run',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--app-dir',
    'C:\\universe-editor\\server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /检查远端计划任务/)
  assert.match(res.stdout, /\[dry-run\] ssh .*echo %comspec%.*探测远端默认 shell/)
  assert.match(res.stdout, /\[dry-run\] ssh .*schtasks \/Query \/TN UniverseUpdateServer/)
  assert.match(res.stdout, /\[dry-run\] scp .*example\.invalid:server\.js\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] ssh .*copy \/Y server\.js\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] scp .*example\.invalid:index\.html\.v\d+/)
  assert.match(res.stdout, /copy \/Y index\.html\.v\d+ "C:\\universe-editor\\data\\index\.html"/)
  assert.match(res.stdout, /schtasks \/Run \/TN UniverseUpdateServer/)
  assert.doesNotMatch(res.stdout, /sudo -n/)
})

test('默认生成并上传 server.env，安装命令带上配置落地步骤', () => {
  const res = runDeploy(
    [
      '--env=prod',
      '--dry-run',
      '--host',
      'example.invalid',
      '--user',
      'deploy',
      '--app-dir',
      '/opt/universe-update-server',
      '--health-url',
      'http://127.0.0.1:9/',
    ],
    { UE_SERVER_PORT: '8080' },
  )
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /服务端配置 server\.env/)
  assert.match(res.stdout, /UE_SERVER_PORT/)
  assert.match(res.stdout, /\[dry-run\] scp .*server\.env\.v\d+/)
  assert.match(res.stdout, /\[dry-run\] ssh .*cp ~\/server\.env\.v\d+/)
})

test('server.env 只含白名单键，部署侧机密不进（UE_RELEASE_* 仅用于 ssh 连接）', () => {
  const res = runDeploy(
    [
      '--env=prod',
      '--dry-run',
      '--host',
      'example.invalid',
      '--user',
      'deploy',
      '--app-dir',
      '/opt/universe-update-server',
      '--health-url',
      'http://127.0.0.1:9/',
    ],
    {
      UE_RELEASE_KEY: '/home/me/.ssh/id_ed25519',
      UE_SERVER_APP_DIR: '/opt/universe-update-server',
    },
  )
  assert.equal(res.status, 0, res.stderr)
  const summary = res.stdout.split(/\r?\n/).find((l) => l.includes('服务端配置 server.env'))
  assert.ok(summary, '缺少 server.env 摘要行')
  assert.doesNotMatch(summary, /UE_RELEASE/)
  // UE_SERVER_APP_DIR 前缀相同但属部署侧参数，不搬上服务器。
  assert.doesNotMatch(summary, /UE_SERVER_APP_DIR/)
  for (const key of summary.slice(summary.indexOf(':') + 1).split(',')) {
    assert.match(key.trim(), /^UE_SERVER_/)
  }
})

test('--skip-env 保留服务器现有配置，不上传也不安装 server.env', () => {
  const res = runDeploy([
    '--env=prod',
    '--dry-run',
    '--skip-env',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--app-dir',
    '/opt/universe-update-server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /保留服务器上现有 server\.env/)
  assert.doesNotMatch(res.stdout, /scp .*server\.env\.v/)
  assert.match(res.stdout, /\[dry-run\] ssh .*sudo -n cp ~\/server\.js/)
})

test('--skip-env 仍部署 index.html，UE_SERVER_ROOT 从远端 server.env 读取', () => {
  const res = runDeploy([
    '--env=prod',
    '--dry-run',
    '--skip-env',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
    '--app-dir',
    '/opt/universe-update-server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  // dry-run 下只打印远端读取命令（真实部署时执行 ssh cat 并解析 UE_SERVER_ROOT）
  assert.match(
    res.stdout,
    /ssh .*"cat \/opt\/universe-update-server\/server\.env".*读远端 server\.env 取 UE_SERVER_ROOT/,
  )
  // index.html 上传与安装步骤不受 --skip-env 影响，安装目标占位为远端读出的 UE_SERVER_ROOT
  assert.match(res.stdout, /\[dry-run\] scp .*index\.html\.v\d+/)
  assert.match(
    res.stdout,
    /sudo -n cp ~\/index\.html\.v\d+ <远端 server\.env 的 UE_SERVER_ROOT>\/index\.html/,
  )
  // server.env 通道仍被跳过
  assert.doesNotMatch(res.stdout, /scp .*server\.env\.v/)
})
