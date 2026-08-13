/*---------------------------------------------------------------------------------------------
 *  服务端运行时配置（UE_SERVER_*）的单一事实源：白名单、平台默认值、server.env 读写。
 *
 *  配置链路：
 *    开发机 .env.<mode>  ──deploy 提取白名单──►  <appDir>/server.env  ──►  服务进程环境变量
 *                                                      ▲
 *                                            setup install 首装时也写它
 *
 *  server.mjs 本身认这些变量（args > env > 默认），所以服务定义只需把 server.env 注入进程环境：
 *  systemd 用 EnvironmentFile，Windows 用 run.cmd 里逐行 set。改配置 = 改 .env.<mode> + 重新
 *  deploy，不必登服务器重装。
 *
 *  ⚠️ 本文件被 setup.mjs 导入，而 setup 的运行场景是「scripts/server/ 整目录拷到服务器」——
 *  那里没有仓库根、没有 node_modules，所以只能依赖 node 内置模块，且不能 import ../lib/*。
 *  parseEnvText 因此在此保留一份最小副本（与 scripts/lib/env.mjs 同语义）。
 *--------------------------------------------------------------------------------------------*/

export const SERVER_ENV_FILE = 'server.env'

// server.mjs 认的运行时配置全集（scripts/server/server.mjs 的 config 块）。deploy 只把这些键
// 从 .env.<mode> 搬到服务器——.env 里还有 UE_RELEASE_KEY 等部署侧机密，绝不上传。
export const SERVER_ENV_KEYS = [
  'UE_SERVER_ROOT',
  'UE_SERVER_GALLERY_ROOT',
  'UE_SERVER_AUTH_DIR',
  'UE_SERVER_PORT',
  'UE_SERVER_HOST',
  'UE_SERVER_BASE',
  'UE_SERVER_MAX_VSIX_SIZE',
  'UE_SERVER_REGISTER_RATE_LIMIT',
  'UE_SERVER_SIGNING_KEY_FILE',
  'UE_SERVER_SIGNING_KEY_ID',
  'UE_SERVER_ADMIN_TOKEN_FILE',
]

// 注：UE_SERVER_APP_DIR / UE_SERVER_HEALTH_URL 前缀相同但属部署侧参数（deploy 自己用），
// 不在上面的白名单里，因此不会被搬上服务器。

// dotenv 兼容子集，与 scripts/lib/env.mjs 的 parseEnvText 同语义（见文件头说明为何复制）。
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function parseEnvText(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const eq = body.indexOf('=')
    if (eq < 0) continue
    const key = body.slice(0, eq).trim()
    if (!KEY_RE.test(key)) continue
    let value = body.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\([nrt\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[c])
    }
    out[key] = value
  }
  return out
}

// 从任意环境映射里提取服务端运行时配置子集（空串视为未设置，避免 .env 里 `KEY=` 覆盖默认值）。
export function pickServerEnv(env) {
  const out = {}
  for (const key of SERVER_ENV_KEYS) {
    const value = env[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = String(value)
  }
  return out
}

// 目标平台的默认发布目录。win 由调用方判定（setup 看 process.platform，deploy 看 appDir 形态）。
export function defaultRoot({ windows }) {
  return windows ? 'C:\\universe-editor\\data' : '/srv/universe-editor'
}

// 目标平台的路径拼接（不能用 node:path——setup 在 Linux 上也可能算 Windows 目标路径，反之亦然）。
function joinPath(base, ...segments) {
  const windows = /^[A-Za-z]:[\\/]/.test(base) || base.includes('\\')
  const sep = windows ? '\\' : '/'
  const trimmed = base.replace(/[\\/]+$/, '')
  return [trimmed, ...segments].join(sep)
}

function parentPath(p) {
  const trimmed = p.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx > 0 ? trimmed.slice(0, idx) : trimmed
}

// 合成完整配置：平台默认 < server.env / .env 提供的覆盖 < CLI 旗标。
// galleryRoot / authDir / 机密文件路径都从 root 派生（只给 --root 时整套跟着走），
// 显式给了就用显式值。
export function buildServerEnv({ windows, overrides = {}, flags = {} }) {
  const explicit = { ...pickServerEnv(overrides), ...pickServerEnv(flags) }
  const root = explicit.UE_SERVER_ROOT ?? defaultRoot({ windows })
  // publish token 目录：绝不能落在静态根之内（server 启动自检会拒），所以取 <root>/../auth。
  const authDir = explicit.UE_SERVER_AUTH_DIR ?? joinPath(parentPath(root), 'auth')
  return {
    UE_SERVER_ROOT: root,
    UE_SERVER_GALLERY_ROOT: explicit.UE_SERVER_GALLERY_ROOT ?? joinPath(root, 'gallery'),
    UE_SERVER_AUTH_DIR: authDir,
    UE_SERVER_PORT: explicit.UE_SERVER_PORT ?? '80',
    UE_SERVER_BASE: explicit.UE_SERVER_BASE ?? '/universe-editor/',
    UE_SERVER_SIGNING_KEY_FILE:
      explicit.UE_SERVER_SIGNING_KEY_FILE ?? joinPath(authDir, 'market-key.pem'),
    UE_SERVER_SIGNING_KEY_ID: explicit.UE_SERVER_SIGNING_KEY_ID ?? 'market-v1',
    UE_SERVER_ADMIN_TOKEN_FILE:
      explicit.UE_SERVER_ADMIN_TOKEN_FILE ?? joinPath(authDir, 'admin-token.txt'),
    // 无默认值的可选项：给了才进 server.env，没给让 server.mjs 用自己的内置默认。
    ...(explicit.UE_SERVER_HOST ? { UE_SERVER_HOST: explicit.UE_SERVER_HOST } : {}),
    ...(explicit.UE_SERVER_MAX_VSIX_SIZE
      ? { UE_SERVER_MAX_VSIX_SIZE: explicit.UE_SERVER_MAX_VSIX_SIZE }
      : {}),
    ...(explicit.UE_SERVER_REGISTER_RATE_LIMIT
      ? { UE_SERVER_REGISTER_RATE_LIMIT: explicit.UE_SERVER_REGISTER_RATE_LIMIT }
      : {}),
  }
}

// 序列化成 server.env。systemd EnvironmentFile 与 cmd 的 set 都不支持多行值与转义，
// 含换行的值直接拒绝（签名私钥等多行内容走文件路径引用，不进这里）。
export function serializeServerEnv(values, { windows = false, mode } = {}) {
  const eol = windows ? '\r\n' : '\n'
  const lines = [
    `# universe-update-server 运行时配置${mode ? `（来自 .env.${mode}）` : ''}——生成物，勿手工编辑`,
    '# 改配置：改开发机 .env.<mode> 后重新 pnpm server:deploy -- --env <mode>',
  ]
  for (const key of SERVER_ENV_KEYS) {
    const value = values[key]
    if (value === undefined || value === null || value === '') continue
    const text = String(value)
    if (/[\r\n]/.test(text)) {
      throw new Error(`${key} 的值含换行，无法写入 server.env（多行内容请改用文件路径引用）`)
    }
    lines.push(`${key}=${text}`)
  }
  return lines.join(eol) + eol
}

// 从环境映射生成 server.env 文本 + 携带的键名（供调用方回显）。
// bundle（首装产物）与 deploy（部署上传）共用，保证两条路生成的配置完全一致。
export function renderServerEnv({ env, windows, mode }) {
  const values = buildServerEnv({ windows, overrides: env })
  return {
    text: serializeServerEnv(values, { windows, mode }),
    keys: Object.keys(values).filter((k) => SERVER_ENV_KEYS.includes(k)),
    values,
  }
}

// 目标平台判定：Windows 路径（盘符或反斜杠）即 Windows 远端。deploy 看 --app-dir，
// bundle 看 .env 里的 UE_SERVER_APP_DIR / UE_SERVER_ROOT。
export function isWindowsPath(p) {
  return typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || p.includes('\\'))
}

// authDir 绝不能落在静态根（root / galleryRoot）之内——与 server.mjs 启动自检同语义
// （前缀比较、大小写敏感）。setup install 在写 server.env 前用它预判：非法配置在首装时
// 当场报错，而不是等服务启动即崩、又碰巧被 run.cmd 的 >nul 2>&1 吞掉报错。
// 命中时返回冲突的静态根，未命中返回 null。
export function findAuthDirConflict({ root, galleryRoot, authDir }) {
  const sep = isWindowsPath(root) || isWindowsPath(authDir) ? '\\' : '/'
  for (const staticRoot of [root, galleryRoot]) {
    const base = staticRoot.replace(/[\\/]+$/, '')
    if (authDir === base || authDir.startsWith(base + sep)) return staticRoot
  }
  return null
}

// deploy 通道的免密 sudo 白名单（server:deploy 的四条远端 root 操作：cp 三路 + restart）。
// index.html 落 <UE_SERVER_ROOT>（发布根）而非 <appDir>，所以 serverRoot 是第三个入参。
// 单一事实源：setup 首装自动写 /etc/sudoers.d/ 与 deploy 的手动配置提示都用它——
// 规则变化（如新增 server.env / index.html 通道）只改这里，两处不再漂移。
export function buildDeploySudoers(user, appDir, serverRoot) {
  return (
    `${user} ALL=(root) NOPASSWD: /usr/bin/cp /home/${user}/server.js.v* ${appDir}/server.mjs, ` +
    `/usr/bin/cp /home/${user}/${SERVER_ENV_FILE}.v* ${appDir}/${SERVER_ENV_FILE}, ` +
    `/usr/bin/cp /home/${user}/index.html.v* ${serverRoot}/index.html, ` +
    `/usr/bin/systemctl restart universe-update-server`
  )
}

// 拼 <appDir>/server.env——目标平台语义，不能用 node:path（deploy 跑在开发机，目标可能是另一 OS）。
export function serverEnvPath(appDir, { windows = false } = {}) {
  return windows
    ? `${appDir.replace(/\//g, '\\').replace(/[\\]+$/, '')}\\${SERVER_ENV_FILE}`
    : joinPath(appDir, SERVER_ENV_FILE)
}
