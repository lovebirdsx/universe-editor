import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildConfig,
  buildHealthTimeoutMessage,
  buildRemoteCleanupCommand,
  buildRemoteManageCommand,
  buildRemoteSetupCommand,
  buildRemoteUnpackCommand,
  buildTarFileList,
  parseArgs,
  pollRemoteVersion,
} from '../setupRemote.mjs'

test('parseArgs 解析 action 与布尔旗标', () => {
  const args = parseArgs(['--env', 'prod', '--action', 'uninstall', '--dry-run', '--yes'])
  assert.equal(args.env, 'prod')
  assert.equal(args.action, 'uninstall')
  assert.equal(args.dryRun, true)
  assert.equal(args.yes, true)
  assert.equal(parseArgs([]).action, undefined)
})

test('buildConfig 优先级 flag > env > 默认，action 默认 install', () => {
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
  assert.equal(fromEnv.action, 'install')

  const fromFlags = buildConfig(
    { host: 'flag-host', 'app-dir': 'C:\\ue\\app', action: 'restart', force: true },
    env,
  )
  assert.equal(fromFlags.host, 'flag-host')
  assert.equal(fromFlags.appDir, 'C:\\ue\\app')
  assert.equal(fromFlags.action, 'restart')
  assert.equal(fromFlags.force, true)
})

test('buildTarFileList 保持 setup.mjs 期望的目录形态，server.env 存在才带，下载页始终带', () => {
  assert.deepEqual(buildTarFileList({ withEnv: false }), [
    'setup.mjs',
    'setup.sh',
    'setup.ps1',
    'serverEnv.mjs',
    'dist/server.js',
    'download-page/index.html',
  ])
  assert.deepEqual(buildTarFileList({ withEnv: true }), [
    'setup.mjs',
    'setup.sh',
    'setup.ps1',
    'serverEnv.mjs',
    'dist/server.js',
    'download-page/index.html',
    'dist/server.env',
  ])
})

test('buildRemoteUnpackCommand Linux 落 ~，Windows 落 %USERPROFILE% 相对路径', () => {
  assert.equal(
    buildRemoteUnpackCommand({ staging: 'ue-server-setup-v4', windows: false }),
    'rm -rf ~/ue-server-setup-v4 && mkdir -p ~/ue-server-setup-v4 && ' +
      'tar -xzf ~/ue-server-setup-v4.tgz -C ~/ue-server-setup-v4 && echo unpacked',
  )
  assert.equal(
    buildRemoteUnpackCommand({ staging: 'ue-server-setup-v4', windows: true }),
    'rmdir /s /q ue-server-setup-v4 2>nul & mkdir ue-server-setup-v4 && ' +
      'tar -xzf ue-server-setup-v4.tgz -C ue-server-setup-v4 && echo unpacked',
  )
})

test('buildRemoteUnpackCommand 两平台都先清重建 staging，且 Windows 不用 if（cmd 会把 & 绑进 if 体）', () => {
  const win = buildRemoteUnpackCommand({ staging: 's', windows: true })
  assert.ok(win.indexOf('rmdir /s /q s') < win.indexOf('mkdir s'))
  assert.ok(win.indexOf('mkdir s') < win.indexOf('tar -xzf'))
  assert.doesNotMatch(win, /\bif\b/)
  const linux = buildRemoteUnpackCommand({ staging: 's', windows: false })
  assert.ok(linux.indexOf('rm -rf ~/s') < linux.indexOf('mkdir -p ~/s'))
  assert.ok(linux.indexOf('mkdir -p ~/s') < linux.indexOf('tar -xzf'))
})

test('buildRemoteSetupCommand Linux：sudo bash setup.sh，--deploy-user 按需追加', () => {
  assert.equal(
    buildRemoteSetupCommand({
      appDir: '/opt/universe-update-server',
      deployUser: 'deploy',
      staging: 'ue-server-setup-v4',
      windows: false,
    }),
    'cd ~/ue-server-setup-v4 && sudo bash setup.sh install ' +
      "--app-dir '/opt/universe-update-server' --deploy-user 'deploy'",
  )
  assert.equal(
    buildRemoteSetupCommand({
      appDir: '/data/app',
      deployUser: null,
      staging: 'ue-server-setup-v4',
      windows: false,
    }),
    "cd ~/ue-server-setup-v4 && sudo bash setup.sh install --app-dir '/data/app'",
  )
})

test('buildRemoteSetupCommand Windows：有 node 直跑 setup.mjs，缺 node 走 setup.ps1，路径归一', () => {
  assert.equal(
    buildRemoteSetupCommand({
      appDir: 'C:/universe-editor/app/',
      staging: 'ue-server-setup-v4',
      windows: true,
      hasNode: true,
    }),
    'cd ue-server-setup-v4 && node setup.mjs install --app-dir "C:\\universe-editor\\app"',
  )
  assert.equal(
    buildRemoteSetupCommand({
      appDir: 'C:\\universe-editor\\app',
      staging: 'ue-server-setup-v4',
      windows: true,
      hasNode: false,
    }),
    'cd ue-server-setup-v4 && powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 ' +
      'install --app-dir "C:\\universe-editor\\app"',
  )
})

test('buildRemoteCleanupCommand 两平台清理暂存目录与 tar 包', () => {
  assert.equal(
    buildRemoteCleanupCommand({ staging: 'ue-server-setup-v4', windows: false }),
    'rm -rf ~/ue-server-setup-v4 ~/ue-server-setup-v4.tgz',
  )
  assert.equal(
    buildRemoteCleanupCommand({ staging: 'ue-server-setup-v4', windows: true }),
    'rmdir /s /q ue-server-setup-v4 2>nul & del ue-server-setup-v4.tgz 2>nul',
  )
})

test('buildRemoteManageCommand Linux：status 无 sudo，restart 用 sudo，uninstall 复刻 setup 语义', () => {
  assert.equal(
    buildRemoteManageCommand({ action: 'status', appDir: '/opt/app', windows: false }),
    'systemctl status universe-update-server',
  )
  assert.equal(
    buildRemoteManageCommand({ action: 'restart', appDir: '/opt/app', windows: false }),
    'sudo systemctl restart universe-update-server',
  )
  assert.equal(
    buildRemoteManageCommand({
      action: 'uninstall',
      appDir: '/opt/universe-update-server',
      windows: false,
    }),
    'sudo systemctl disable --now universe-update-server; ' +
      'sudo rm -f /etc/systemd/system/universe-update-server.service; ' +
      'sudo systemctl daemon-reload; ' +
      "sudo rm -rf '/opt/universe-update-server'",
  )
})

test('buildRemoteManageCommand Windows：schtasks 三动作，uninstall 防火墙按通配清理', () => {
  assert.equal(
    buildRemoteManageCommand({ action: 'status', appDir: 'C:\\ue\\app', windows: true }),
    'schtasks /Query /TN UniverseUpdateServer /V /FO LIST',
  )
  assert.equal(
    buildRemoteManageCommand({ action: 'restart', appDir: 'C:\\ue\\app', windows: true }),
    'schtasks /End /TN UniverseUpdateServer 2>nul & ping -n 3 127.0.0.1 >nul & ' +
      'schtasks /Run /TN UniverseUpdateServer',
  )
  const uninstall = buildRemoteManageCommand({
    action: 'uninstall',
    appDir: 'C:/universe-editor/app/',
    windows: true,
  })
  assert.match(uninstall, /schtasks \/Delete \/TN UniverseUpdateServer \/F/)
  assert.match(uninstall, /Remove-NetFirewallRule -DisplayName 'Universe Update Server\*'/)
  assert.match(uninstall, /rmdir \/s \/q "C:\\universe-editor\\app"/)
  assert.equal(
    buildRemoteManageCommand({ action: 'bogus', appDir: '/opt/app', windows: false }),
    null,
  )
})

const setupScript = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'setupRemote.mjs')

function runSetup(args, env = {}) {
  const cleanEnv = { ...process.env, ...env }
  delete cleanEnv.UE_ENV
  return spawnSync(process.execPath, [setupScript, ...args], {
    encoding: 'utf8',
    env: cleanEnv,
    cwd: join(dirname(setupScript), '..', '..'),
  })
}

test('未显式指定环境时直接拒绝', () => {
  const res = runSetup([])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /必须显式指定目标环境/)
})

test('未知 action 直接拒绝', () => {
  const res = runSetup([
    '--env=prod',
    '--action',
    'explode',
    '--host',
    'example.invalid',
    '--user',
    'deploy',
  ])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /未知 --action/)
})

const linuxDryRun = [
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
]

test('install dry-run：全链路只打印命令，ssh -t 下 sudo 提权并下传 --deploy-user', () => {
  const res = runSetup(linuxDryRun)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /\[prod\] 远程首装/)
  assert.match(res.stdout, /\[dry-run\] pnpm server:bundle -- --env prod/)
  assert.match(res.stdout, /\[dry-run\] tar -czf .*ue-server-setup-v\d+\.tgz -C .*setup\.mjs/)
  assert.match(res.stdout, /\[dry-run\] scp .*example\.invalid:~\/ue-server-setup-v\d+\.tgz/)
  assert.match(res.stdout, /mkdir -p ~\/ue-server-setup-v\d+ && tar -xzf/)
  assert.match(res.stdout, /ssh .*-t .*sudo bash setup\.sh install --app-dir/)
  assert.match(res.stdout, /--deploy-user 'deploy'/)
  assert.match(res.stdout, /\[dry-run\] .*rm -rf ~\/ue-server-setup-v\d+/)
  assert.match(res.stdout, /健康验证将轮询/)
  assert.doesNotMatch(res.stdout, /继续远程首装\?/)
})

test('install dry-run：非法 Linux 用户名时下传被跳过', () => {
  const res = runSetup([
    '--env=prod',
    '--dry-run',
    '--host',
    'example.invalid',
    '--user',
    'bad.name',
    '--app-dir',
    '/opt/universe-update-server',
    '--health-url',
    'http://127.0.0.1:9/',
  ])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sudo bash setup\.sh install/)
  assert.doesNotMatch(res.stdout, /--deploy-user/)
})

const windowsDryRun = [
  '--env=test',
  '--dry-run',
  '--host',
  'example.invalid',
  '--user',
  'Administrator',
  '--app-dir',
  'C:\\universe-editor\\app',
  '--health-url',
  'http://127.0.0.1:9/',
]

test('install dry-run Windows：tar 相对落 %USERPROFILE%，探测 node 后直跑 setup.mjs，无 sudo', () => {
  const res = runSetup(windowsDryRun)
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /\[test\] 远程首装/)
  assert.match(res.stdout, /\[dry-run\] ssh .*echo %comspec%.*探测远端默认 shell/)
  assert.match(res.stdout, /\[dry-run\] scp .*example\.invalid:ue-server-setup-v\d+\.tgz/)
  assert.match(res.stdout, /rmdir \/s \/q ue-server-setup-v\d+ 2>nul & mkdir ue-server-setup-v\d+ && tar -xzf/)
  assert.match(res.stdout, /\[dry-run\] ssh .*node --version/)
  assert.match(res.stdout, /cd ue-server-setup-v\d+ && node setup\.mjs install --app-dir/)
  assert.doesNotMatch(res.stdout, /sudo/)
})

test('status/restart dry-run Linux：原生命令直发，restart 带 -t，无确认', () => {
  for (const [action, pattern] of [
    ['status', /ssh .*systemctl status universe-update-server/],
    ['restart', /ssh .*-t .*sudo systemctl restart universe-update-server/],
  ]) {
    const res = runSetup([...linuxDryRun, '--action', action])
    assert.equal(res.status, 0, res.stderr)
    assert.match(res.stdout, pattern)
    assert.doesNotMatch(res.stdout, /pnpm server:bundle/)
  }
})

test('uninstall dry-run Linux：复刻 setup 语义的原生命令链', () => {
  const res = runSetup([...linuxDryRun, '--action', 'uninstall'])
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /sudo systemctl disable --now universe-update-server/)
  assert.match(res.stdout, /sudo rm -f \/etc\/systemd\/system\/universe-update-server\.service/)
  assert.match(res.stdout, /sudo rm -rf '\/opt\/universe-update-server'/)
  assert.doesNotMatch(res.stdout, /确认卸载/)
})

test('status/uninstall dry-run Windows：schtasks 查询与删除 + 防火墙通配清理', () => {
  const status = runSetup([...windowsDryRun, '--action', 'status'])
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /\[dry-run\] ssh .*echo %comspec%/)
  assert.match(status.stdout, /schtasks \/Query \/TN UniverseUpdateServer \/V \/FO LIST/)

  const uninstall = runSetup([...windowsDryRun, '--action', 'uninstall'])
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.match(uninstall.stdout, /schtasks \/Delete \/TN UniverseUpdateServer \/F/)
  assert.match(uninstall.stdout, /Remove-NetFirewallRule -DisplayName 'Universe Update Server\*'/)
  assert.match(uninstall.stdout, /rmdir \/s \/q "C:\\universe-editor\\app"/)
})

test('appDir 过宽（根目录）时拒绝执行', () => {
  const res = runSetup([...linuxDryRun, '--app-dir', '/'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /appDir 过于宽泛/)
})

test('pollRemoteVersion：版本匹配即成功（可带前置重试），不匹配也持续轮询', async () => {
  const seq = [null, null, '9', '10']
  let i = 0
  const mismatches = []
  const ok = await pollRemoteVersion({
    fetchImpl: async () => seq[Math.min(i++, seq.length - 1)],
    healthUrl: 'http://h/',
    localVersion: '10',
    sleepMs: 0,
    onMismatch: (v, attempt) => mismatches.push([v, attempt]),
  })
  assert.equal(ok, true)
  // null（连接失败）静默重试，只有拿到不一致版本才经 onMismatch 报告
  assert.deepEqual(mismatches, [['9', 3]])
})

test('pollRemoteVersion：始终拿不到期望版本返回 false（对应 die 分支）', async () => {
  let calls = 0
  const ok = await pollRemoteVersion({
    fetchImpl: async () => {
      calls++
      return null
    },
    healthUrl: 'http://h/',
    localVersion: '10',
    attempts: 3,
    sleepMs: 0,
  })
  assert.equal(ok, false)
  assert.equal(calls, 3)
})

test('buildHealthTimeoutMessage：Windows 给任务状态 + run.cmd 手动排障指引，Linux 给 journalctl', () => {
  const win = buildHealthTimeoutMessage({
    healthUrl: 'http://127.0.0.1/',
    localVersion: '10',
    windows: true,
    remote: 'songxiao@127.0.0.1',
    appDir: 'C:/universe-editor/app/',
  })
  assert.match(win, /健康验证超时：http:\/\/127\.0\.0\.1\/ 未返回 v10/)
  assert.match(win, /schtasks \/Query \/TN UniverseUpdateServer/)
  // run.cmd 路径归一成 Windows 形态（去尾斜杠、正反斜杠统一）
  assert.match(win, /C:\\universe-editor\\app\\run\.cmd/)
  assert.match(win, />nul 2>&1/)

  const linux = buildHealthTimeoutMessage({
    healthUrl: 'http://srv/',
    localVersion: '10',
    windows: false,
    remote: 'deploy@srv',
    appDir: '/opt/app',
  })
  assert.match(linux, /journalctl -u universe-update-server/)
  assert.doesNotMatch(linux, /schtasks/)
})
