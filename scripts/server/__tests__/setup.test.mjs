import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildConfig,
  buildPublishAccessCommands,
  buildSystemdUnit,
  buildWindowsLauncher,
  decodeNativeOutput,
  isValidDeployUser,
  resolveEnvOverrides,
} from '../setup.mjs'
import { buildDeploySudoers } from '../serverEnv.mjs'

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEnv = join(serverDir, 'dist', 'server.env')

// dist/server.env 参与 setup 的查找顺序，开发者机器上可能残留一份（跑过 bundle --env）。
// 全程移开，让每个用例自己决定它存不存在——否则本地与 CI 结果会不一致。
let stashed = null
before(() => {
  mkdirSync(join(serverDir, 'dist'), { recursive: true })
  if (existsSync(distEnv)) {
    stashed = readFileSync(distEnv)
    rmSync(distEnv)
  }
})
after(() => {
  if (stashed) writeFileSync(distEnv, stashed)
})

// 在 dist/server.env 存在的前提下跑 fn，结束后恢复"不存在"状态。
function withDistEnv(content, fn) {
  writeFileSync(distEnv, content)
  try {
    return fn(distEnv)
  } finally {
    rmSync(distEnv, { force: true })
  }
}

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

test('resolveEnvOverrides 优先读 dist/server.env（bundle --env 随包带来的首装配置）', () => {
  withDistEnv('UE_SERVER_PORT=7777\n', (distFile) => {
    withTempDir((installed) => {
      // 安装目录里已有一份旧配置，dist 的那份（这次要装的）应当胜出。
      writeFileSync(join(installed, 'server.env'), 'UE_SERVER_PORT=9090\n')
      const { file, values } = resolveEnvOverrides({}, installed)
      assert.equal(file, distFile)
      assert.deepEqual(values, { UE_SERVER_PORT: '7777' })
    })
  })
})

test('resolveEnvOverrides 中 --env-file 压过 dist/server.env', () => {
  withDistEnv('UE_SERVER_PORT=7777\n', () => {
    withTempDir((dir) => {
      const explicit = join(dir, 'explicit.env')
      writeFileSync(explicit, 'UE_SERVER_PORT=6666\n')
      const { file, values } = resolveEnvOverrides({ 'env-file': explicit }, null)
      assert.equal(file, explicit)
      assert.deepEqual(values, { UE_SERVER_PORT: '6666' })
    })
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

test('buildConfig 只给 root 时机密文件与 authDir 跟着派生', () =>
  withTempDir((dir) => {
    // 显式空 env-file 跳过查找链——本机真装过服务时安装目录的 server.env 会经 fallback 命中污染用例
    const empty = join(dir, 'empty.env')
    writeFileSync(empty, '')
    const cfg = buildConfig({ root: '/data/ue', 'env-file': empty })
    assert.match(cfg.galleryRoot.replace(/\\/g, '/'), /\/data\/ue\/gallery$/)
    assert.match(cfg.authDir.replace(/\\/g, '/'), /\/data\/auth$/)
    assert.match(cfg.signingKeyFile.replace(/\\/g, '/'), /\/data\/auth\/market-key\.pem$/)
    assert.match(cfg.adminTokenFile.replace(/\\/g, '/'), /\/data\/auth\/admin-token\.txt$/)
  }))

test('buildConfig 布尔旗标（--port 后没跟值）不覆盖配置', () =>
  withTempDir((dir) => {
    // 显式空 env-file 跳过查找链——本机真装过服务时安装目录的 server.env 会经 fallback 命中污染用例
    const empty = join(dir, 'empty.env')
    writeFileSync(empty, '')
    const cfg = buildConfig({ port: true, 'env-file': empty })
    assert.equal(cfg.port, '80')
  }))

test('buildConfig --deploy-user：字符串生效，未传或布尔占位为 null（跳过 sudoers 写入）', () => {
  assert.equal(buildConfig({ 'deploy-user': 'deploy' }).deployUser, 'deploy')
  assert.equal(buildConfig({}).deployUser, null)
  assert.equal(buildConfig({ 'deploy-user': true }).deployUser, null)
})

test('buildDeploySudoers 的 index.html 通道随 UE_SERVER_ROOT 派生（setup --deploy-user 写 sudoers 的契约）', () => {
  const rule = buildDeploySudoers('deploy', '/opt/app', '/srv/releases')
  assert.match(rule, /\/home\/deploy\/index\.html\.v\* \/srv\/releases\/index\.html/)
  const other = buildDeploySudoers('deploy', '/opt/app', '/data/releases')
  assert.match(other, /\/home\/deploy\/index\.html\.v\* \/data\/releases\/index\.html/)
})

test('isValidDeployUser 按 Linux 用户名规则严格白名单（防 sudoers 换行注入）', () => {
  for (const ok of ['deploy', 'root', '_svc', 'svc-01', 'a']) {
    assert.equal(isValidDeployUser(ok), true, ok)
  }
  for (const bad of ['', 'Deploy', '0abc', 'a b', 'bad.name', 'deploy\nroot ALL=(ALL) ALL', null]) {
    assert.equal(isValidDeployUser(bad), false, String(bad))
  }
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

test('decodeNativeOutput：GBK 字节按中文系统 ANSI 代码页解码，UTF-8/ASCII 原样通过', () => {
  // 「成功」的 GBK 编码——schtasks 在中文系统上的典型输出
  assert.equal(decodeNativeOutput(Buffer.from([0xb3, 0xc9, 0xb9, 0xa6])), '成功')
  assert.equal(decodeNativeOutput(Buffer.from('plain ascii\n', 'utf8')), 'plain ascii\n')
  assert.equal(decodeNativeOutput(Buffer.from('已是UTF-8文本\n', 'utf8')), '已是UTF-8文本\n')
  assert.equal(decodeNativeOutput(null), '')
  assert.equal(decodeNativeOutput(Buffer.alloc(0)), '')
})

test('buildPublishAccessCommands：deployUser 为 null/空时返回空数组', () => {
  for (const deployUser of [null, '']) {
    assert.deepEqual(
      buildPublishAccessCommands({
        deployUser,
        root: '/srv/x',
        galleryRoot: '/srv/x/gallery',
        secretFiles: [],
      }),
      [],
    )
  }
})

test('buildPublishAccessCommands 完整序列：usermod → root 组写+setgid → 机密 600（galleryRoot 在 root 内不重复）', () => {
  const cmds = buildPublishAccessCommands({
    deployUser: 'publish',
    root: '/srv/x',
    galleryRoot: '/srv/x/gallery',
    secretFiles: ['/srv/x/auth/market-key.pem', '/srv/x/auth/admin-token.txt'],
  })
  assert.deepEqual(cmds, [
    ['usermod', ['-aG', 'www-data', 'publish']],
    ['chmod', ['-R', 'g+w', '/srv/x']],
    ['find', ['/srv/x', '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+']],
    ['chmod', ['600', '/srv/x/auth/market-key.pem']],
    ['chmod', ['600', '/srv/x/auth/admin-token.txt']],
  ])
})

test('buildPublishAccessCommands galleryRoot 在 root 外时追加它自己的 chmod+find', () => {
  const cmds = buildPublishAccessCommands({
    deployUser: 'publish',
    root: '/srv/x',
    galleryRoot: '/data/gallery',
    secretFiles: [],
  })
  assert.deepEqual(cmds, [
    ['usermod', ['-aG', 'www-data', 'publish']],
    ['chmod', ['-R', 'g+w', '/srv/x']],
    ['find', ['/srv/x', '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+']],
    ['chmod', ['-R', 'g+w', '/data/gallery']],
    ['find', ['/data/gallery', '-type', 'd', '-exec', 'chmod', 'g+s', '{}', '+']],
  ])
})

test('buildPublishAccessCommands 机密文件每个追加 chmod 600 且排在序列末尾', () => {
  const cmds = buildPublishAccessCommands({
    deployUser: 'publish',
    root: '/srv/x',
    galleryRoot: '/srv/x/gallery',
    secretFiles: ['/srv/x/key.pem', '/srv/x/token.txt'],
  })
  assert.deepEqual(cmds.slice(-2), [
    ['chmod', ['600', '/srv/x/key.pem']],
    ['chmod', ['600', '/srv/x/token.txt']],
  ])
})

const setupScript = resolve(serverDir, 'setup.mjs')

test('install：auth-dir 落在静态根之内时当场拒绝，且拒绝发生在任何副作用之前', () =>
  withTempDir((dir) => {
    const envFile = join(dir, 'server.env')
    writeFileSync(envFile, `UE_SERVER_ROOT=${dir}\nUE_SERVER_AUTH_DIR=${join(dir, 'auth')}\n`)
    const res = spawnSync(
      process.execPath,
      [setupScript, 'install', '--env-file', envFile, '--app-dir', join(dir, 'app')],
      { encoding: 'utf8' },
    )
    assert.equal(res.status, 1, res.stderr)
    assert.match(res.stderr, /auth-dir 不能落在静态服务目录/)
    // die 在 installWin/installLinux 之前：安装目录不应被创建
    assert.equal(existsSync(join(dir, 'app')), false)
  }))
