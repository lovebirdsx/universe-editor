import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SERVER_ENV_KEYS,
  buildDeploySudoers,
  buildServerEnv,
  findAuthDirConflict,
  isWindowsPath,
  parseEnvText,
  pickServerEnv,
  renderServerEnv,
  serializeServerEnv,
  serverEnvPath,
} from '../serverEnv.mjs'

test('pickServerEnv 只取白名单，部署侧机密与空值不进', () => {
  const picked = pickServerEnv({
    UE_SERVER_ROOT: '/srv/ue',
    UE_SERVER_PORT: '8080',
    UE_SERVER_HOST: '',
    UE_RELEASE_KEY: '/home/me/.ssh/id_ed25519',
    UE_RELEASE_HOST: '192.0.2.10',
    RANDOM_SECRET: 'nope',
  })
  assert.deepEqual(picked, { UE_SERVER_ROOT: '/srv/ue', UE_SERVER_PORT: '8080' })
})

test('pickServerEnv 排除部署侧的 UE_SERVER_APP_DIR / HEALTH_URL', () => {
  const picked = pickServerEnv({
    UE_SERVER_APP_DIR: '/opt/universe-update-server',
    UE_SERVER_HEALTH_URL: 'http://192.0.2.10/',
    UE_SERVER_ROOT: '/srv/ue',
  })
  assert.deepEqual(picked, { UE_SERVER_ROOT: '/srv/ue' })
  assert.equal(SERVER_ENV_KEYS.includes('UE_SERVER_APP_DIR'), false)
  assert.equal(SERVER_ENV_KEYS.includes('UE_SERVER_HEALTH_URL'), false)
})

test('buildServerEnv Linux 默认值：authDir 在静态根之外，机密文件落 authDir', () => {
  const env = buildServerEnv({ windows: false })
  assert.equal(env.UE_SERVER_ROOT, '/srv/universe-editor')
  assert.equal(env.UE_SERVER_GALLERY_ROOT, '/srv/universe-editor/gallery')
  assert.equal(env.UE_SERVER_AUTH_DIR, '/srv/auth')
  assert.equal(env.UE_SERVER_SIGNING_KEY_FILE, '/srv/auth/market-key.pem')
  assert.equal(env.UE_SERVER_ADMIN_TOKEN_FILE, '/srv/auth/admin-token.txt')
  assert.equal(env.UE_SERVER_PORT, '80')
  assert.equal(env.UE_SERVER_BASE, '/universe-editor/')
  assert.equal(env.UE_SERVER_SIGNING_KEY_ID, 'market-v1')
})

test('buildServerEnv Windows 默认值用反斜杠', () => {
  const env = buildServerEnv({ windows: true })
  assert.equal(env.UE_SERVER_ROOT, 'C:\\universe-editor\\data')
  assert.equal(env.UE_SERVER_GALLERY_ROOT, 'C:\\universe-editor\\data\\gallery')
  assert.equal(env.UE_SERVER_AUTH_DIR, 'C:\\universe-editor\\auth')
  assert.equal(env.UE_SERVER_SIGNING_KEY_FILE, 'C:\\universe-editor\\auth\\market-key.pem')
})

test('buildServerEnv 只给 root 时 galleryRoot/authDir/机密路径整套跟着派生', () => {
  const env = buildServerEnv({ windows: false, flags: { UE_SERVER_ROOT: '/data/ue' } })
  assert.equal(env.UE_SERVER_GALLERY_ROOT, '/data/ue/gallery')
  assert.equal(env.UE_SERVER_AUTH_DIR, '/data/auth')
  assert.equal(env.UE_SERVER_SIGNING_KEY_FILE, '/data/auth/market-key.pem')
})

test('buildServerEnv 优先级 flags > overrides > 默认', () => {
  const env = buildServerEnv({
    windows: false,
    overrides: { UE_SERVER_PORT: '8080', UE_SERVER_BASE: '/from-env/' },
    flags: { UE_SERVER_PORT: '9090' },
  })
  assert.equal(env.UE_SERVER_PORT, '9090')
  assert.equal(env.UE_SERVER_BASE, '/from-env/')
  assert.equal(env.UE_SERVER_ROOT, '/srv/universe-editor')
})

test('buildServerEnv 无默认值的可选项没给就不出现（让 server.mjs 用内置默认）', () => {
  const env = buildServerEnv({ windows: false })
  assert.equal('UE_SERVER_HOST' in env, false)
  assert.equal('UE_SERVER_MAX_VSIX_SIZE' in env, false)
  assert.equal('UE_SERVER_REGISTER_RATE_LIMIT' in env, false)

  const withOptional = buildServerEnv({
    windows: false,
    overrides: { UE_SERVER_REGISTER_RATE_LIMIT: '0' },
  })
  assert.equal(withOptional.UE_SERVER_REGISTER_RATE_LIMIT, '0')
})

test('serializeServerEnv 输出 KEY=VALUE，按目标平台换行', () => {
  const text = serializeServerEnv({ UE_SERVER_ROOT: '/srv/ue', UE_SERVER_PORT: '80' })
  assert.match(text, /^# universe-update-server/)
  assert.match(text, /\nUE_SERVER_ROOT=\/srv\/ue\n/)
  assert.match(text, /\nUE_SERVER_PORT=80\n/)
  assert.equal(text.includes('\r\n'), false)

  const win = serializeServerEnv({ UE_SERVER_ROOT: 'C:\\ue' }, { windows: true })
  assert.match(win, /\r\nUE_SERVER_ROOT=C:\\ue\r\n/)
})

test('serializeServerEnv 值不加引号——systemd EnvironmentFile 与 cmd set 都会把引号算进值', () => {
  const text = serializeServerEnv({ UE_SERVER_ROOT: '/srv/my data' })
  assert.match(text, /\nUE_SERVER_ROOT=\/srv\/my data\n/)
})

test('serializeServerEnv 拒绝多行值（PEM 正文只能走文件路径引用）', () => {
  assert.throws(
    () => serializeServerEnv({ UE_SERVER_SIGNING_KEY_FILE: '-----BEGIN\nkey\n-----END' }),
    /含换行/,
  )
})

test('serializeServerEnv 跳过空值，输出可被 parseEnvText 往返解析', () => {
  const values = buildServerEnv({ windows: false, flags: { UE_SERVER_PORT: '8080' } })
  const roundTripped = parseEnvText(serializeServerEnv(values))
  assert.deepEqual(roundTripped, values)
})

test('serverEnvPath 按目标平台拼路径', () => {
  assert.equal(
    serverEnvPath('C:\\universe-editor\\app', { windows: true }),
    'C:\\universe-editor\\app\\server.env',
  )
  assert.equal(
    serverEnvPath('C:/universe-editor/app/', { windows: true }),
    'C:\\universe-editor\\app\\server.env',
  )
})

test('isWindowsPath 按盘符/反斜杠识别', () => {
  assert.equal(isWindowsPath('C:\\universe-editor\\app'), true)
  assert.equal(isWindowsPath('C:/universe-editor/app'), true)
  assert.equal(isWindowsPath('/opt/universe-update-server'), false)
  assert.equal(isWindowsPath(''), false)
  assert.equal(isWindowsPath(undefined), false)
})

test('renderServerEnv 同一 .env 在 bundle（首装）与 deploy 两条路生成完全相同的配置', () => {
  const env = {
    UE_SERVER_ROOT: '/srv/ue',
    UE_SERVER_PORT: '8080',
    UE_RELEASE_KEY: '/home/me/.ssh/id_ed25519',
  }
  const a = renderServerEnv({ env, windows: false, mode: 'prod' })
  const b = renderServerEnv({ env, windows: false, mode: 'prod' })
  assert.equal(a.text, b.text)
  assert.deepEqual(a.keys, b.keys)
  // 白名单外的部署侧机密不进产物。
  assert.doesNotMatch(a.text, /UE_RELEASE_KEY|id_ed25519/)
  // 头注释标明来源 mode，便于在服务器上确认配置出处。
  assert.match(a.text, /来自 \.env\.prod/)
})

test('renderServerEnv 文本可被 parseEnvText 还原成 values', () => {
  const { text, values } = renderServerEnv({
    env: { UE_SERVER_PORT: '9090' },
    windows: false,
    mode: 'test',
  })
  assert.deepEqual(parseEnvText(text), values)
})

test('buildDeploySudoers 覆盖 deploy 四条远端 root 操作（cp 三路 + restart）+ true 探测锚点', () => {
  assert.equal(
    buildDeploySudoers('deploy', '/opt/universe-update-server', '/srv/universe-editor'),
    'deploy ALL=(root) NOPASSWD: ' +
      '/usr/bin/cp /home/deploy/server.js.v* /opt/universe-update-server/server.mjs, ' +
      '/usr/bin/cp /home/deploy/server.env.v* /opt/universe-update-server/server.env, ' +
      '/usr/bin/cp /home/deploy/index.html.v* /srv/universe-editor/index.html, ' +
      '/usr/bin/systemctl restart universe-update-server, ' +
      '/usr/bin/true',
  )
})

test('findAuthDirConflict 与 server.mjs 启动自检同语义（前缀比较、返回冲突根）', () => {
  assert.equal(
    findAuthDirConflict({
      root: 'C:\\universe-editor\\data',
      galleryRoot: 'C:\\universe-editor\\data\\gallery',
      authDir: 'C:\\universe-editor\\data\\auth',
    }),
    'C:\\universe-editor\\data',
  )
  // 落在 galleryRoot（root 之外独立静态根）也算命中
  assert.equal(
    findAuthDirConflict({
      root: '/srv/ue',
      galleryRoot: '/data/gallery',
      authDir: '/data/gallery/auth',
    }),
    '/data/gallery',
  )
  // 与静态根完全相等也命中
  assert.equal(
    findAuthDirConflict({ root: '/srv/ue', galleryRoot: '/srv/ue/gallery', authDir: '/srv/ue' }),
    '/srv/ue',
  )
  // 兄弟目录 / 静态根之外不命中
  assert.equal(
    findAuthDirConflict({
      root: 'C:\\universe-editor\\data',
      galleryRoot: 'C:\\universe-editor\\data\\gallery',
      authDir: 'C:\\universe-editor\\auth',
    }),
    null,
  )
  assert.equal(
    findAuthDirConflict({ root: '/srv/ue', galleryRoot: '/srv/ue/gallery', authDir: '/srv/auth' }),
    null,
  )
  // 前缀必须在路径边界上：database 不是 data 的子路径
  assert.equal(
    findAuthDirConflict({
      root: '/srv/data',
      galleryRoot: '/srv/data/gallery',
      authDir: '/srv/database',
    }),
    null,
  )
  // 静态根带尾斜杠也能正确判定
  assert.equal(
    findAuthDirConflict({
      root: 'C:\\universe-editor\\data\\',
      galleryRoot: 'C:\\universe-editor\\data\\gallery',
      authDir: 'C:\\universe-editor\\data\\auth',
    }),
    'C:\\universe-editor\\data\\',
  )
})
