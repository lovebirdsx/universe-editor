import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildConfig,
  buildSystemdUnit,
  buildWindowsLauncher,
  resolveEnvOverrides,
} from '../setup.mjs'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ue-setup-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('resolveEnvOverrides 读 --env-file 指定的 server.env', () => {
  withTempDir((dir) => {
    const file = join(dir, 'custom.env')
    writeFileSync(file, '# 注释\nUE_SERVER_PORT=8080\nUE_SERVER_BASE=/ue/\n')
    const { file: found, values } = resolveEnvOverrides({ 'env-file': file }, null)
    assert.equal(found, file)
    assert.deepEqual(values, { UE_SERVER_PORT: '8080', UE_SERVER_BASE: '/ue/' })
  })
})

test('resolveEnvOverrides 找不到任何 server.env 时返回空覆盖', () => {
  withTempDir((dir) => {
    const { file, values } = resolveEnvOverrides({}, join(dir, 'nonexistent'))
    assert.equal(file, null)
    assert.deepEqual(values, {})
  })
})

test('resolveEnvOverrides 回落到安装目录已有的 server.env（不带参数重跑 install 不丢配置）', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'server.env'), 'UE_SERVER_PORT=9090\n')
    const { file, values } = resolveEnvOverrides({}, dir)
    assert.equal(file, join(dir, 'server.env'))
    assert.deepEqual(values, { UE_SERVER_PORT: '9090' })
  })
})

test('buildConfig 优先级 CLI 旗标 > server.env > 平台默认', () => {
  withTempDir((dir) => {
    const file = join(dir, 'server.env')
    writeFileSync(file, 'UE_SERVER_PORT=8080\nUE_SERVER_BASE=/from-file/\n')
    const cfg = buildConfig({ 'env-file': file, port: '9090' })
    assert.equal(cfg.port, '9090')
    assert.equal(cfg.base, '/from-file/')
    assert.equal(cfg.signingKeyId, 'market-v1')
    assert.equal(cfg.envFile, file)
  })
})

test('buildConfig 路径全部 resolve 成绝对路径（服务运行时 cwd 不是当前目录）', () => {
  const cfg = buildConfig({ root: 'relative-root' })
  for (const p of [
    cfg.root,
    cfg.galleryRoot,
    cfg.authDir,
    cfg.signingKeyFile,
    cfg.adminTokenFile,
  ]) {
    assert.ok(/^([A-Za-z]:[\\/]|\/)/.test(p), `应为绝对路径: ${p}`)
  }
})

test('buildConfig 只给 root 时机密文件与 authDir 跟着派生', () => {
  const cfg = buildConfig({ root: '/data/ue' })
  assert.match(cfg.galleryRoot.replace(/\\/g, '/'), /\/data\/ue\/gallery$/)
  assert.match(cfg.authDir.replace(/\\/g, '/'), /\/data\/auth$/)
  assert.match(cfg.signingKeyFile.replace(/\\/g, '/'), /\/data\/auth\/market-key\.pem$/)
  assert.match(cfg.adminTokenFile.replace(/\\/g, '/'), /\/data\/auth\/admin-token\.txt$/)
})

test('buildConfig 布尔旗标（--port 后没跟值）不覆盖配置', () => {
  const cfg = buildConfig({ port: true })
  assert.equal(cfg.port, '80')
})

test('buildConfig 机密文件不再是可选项——总有默认路径，供 install 自动生成', () => {
  const cfg = buildConfig({})
  assert.ok(cfg.signingKeyFile)
  assert.ok(cfg.adminTokenFile)
  assert.equal(cfg.env.UE_SERVER_SIGNING_KEY_FILE, cfg.signingKeyFile)
  assert.equal(cfg.env.UE_SERVER_ADMIN_TOKEN_FILE, cfg.adminTokenFile)
})

test('buildSystemdUnit 用 EnvironmentFile 注入配置，ExecStart 不带配置旗标', () => {
  const unit = buildSystemdUnit({
    nodePath: '/usr/bin/node',
    serverPath: '/opt/universe-update-server/server.mjs',
    envFile: '/opt/universe-update-server/server.env',
  })
  assert.match(unit, /^EnvironmentFile=\/opt\/universe-update-server\/server\.env$/m)
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/universe-update-server\/server\.mjs$/m)
  // 配置改走 server.env 后，unit 里不应再出现任何 --flag（改配置不必 daemon-reload）。
  assert.doesNotMatch(unit, /ExecStart=.*--/)
})

test('buildWindowsLauncher 先加载 server.env 再起 node，输出重定向保留', () => {
  const launcher = buildWindowsLauncher({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    serverPath: 'C:\\universe-editor\\app\\server.mjs',
    envFile: 'C:\\universe-editor\\app\\server.env',
  })
  const lines = launcher.split('\r\n')
  // tokens=1* delims== 保证 base64 令牌里的 = 与空格不被截断；eol=# 跳过注释行。
  assert.match(lines[2], /^for \/f "usebackq eol=# tokens=1\* delims==" %%a in \(/)
  assert.match(lines[2], /C:\\universe-editor\\app\\server\.env/)
  assert.ok(lines.indexOf(lines[2]) < lines.findIndex((l) => l.includes('node.exe')))
  // Task Scheduler 下 stdout 句柄无效，不重定向 node 写横幅就 EBADF 崩。
  assert.match(launcher, />nul 2>&1/)
  assert.equal(launcher.includes('\n\n'), false)
})
