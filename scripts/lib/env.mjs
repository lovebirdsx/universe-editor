/*---------------------------------------------------------------------------------------------
 *  统一 .env loader：解析 dotenv 兼容子集，按 mode 分层加载 .env 文件。
 *
 *  用法（在任意仓库脚本顶部）:
 *    import { loadEnv } from '../lib/env.mjs'
 *    const { mode } = loadEnv()   // mode 由 --env <mode> 旗标或 UE_ENV 决定，默认 dev
 *
 *  分层优先级（高 → 低）:
 *    shell 环境变量 > .env.<mode>.local > .env.<mode> > .env.local > .env
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const MODE_RE = /^[a-z0-9-]+$/

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

export function resolveMode(argv, env) {
  let mode
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env' && i + 1 < argv.length) mode = argv[i + 1]
    else if (argv[i].startsWith('--env=')) mode = argv[i].slice('--env='.length)
  }
  mode ??= env.UE_ENV ?? 'dev'
  if (!MODE_RE.test(mode)) {
    throw new Error(`非法 --env/UE_ENV 值 "${mode}"：只允许 [a-z0-9-]，防止拼出意外的文件路径`)
  }
  return mode
}

export function loadEnv({ cwd, argv, env, quiet } = {}) {
  cwd ??= resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  argv ??= process.argv.slice(2)
  env ??= process.env
  const mode = resolveMode(argv, env)
  const merged = {}
  const files = []
  for (const name of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const file = join(cwd, name)
    if (!existsSync(file)) continue
    files.push(file)
    Object.assign(merged, parseEnvText(readFileSync(file, 'utf8')))
  }
  for (const [key, value] of Object.entries(merged)) {
    if (!(key in env)) env[key] = value
  }
  if (!quiet) {
    const detail =
      files.length > 0
        ? `← ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`
        : '（未找到 .env 文件）'
    console.log(`\x1b[2m[env] mode=${mode} ${detail}\x1b[0m`)
  }
  return { mode, files }
}
