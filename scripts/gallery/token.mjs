#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  市场 publish token 的运维签发/吊销工具（Phase D；自助注册属公开阶段，见计划 06）。
 *
 *  直接读写服务器认证目录里的 publishers.json（ssh 上去跑，或对本地副本跑完随既有 scp
 *  通道上传）——内部阶段不为签发做 HTTP API，签发面越小越好。
 *
 *  用法:
 *    node scripts/gallery/token.mjs issue  --publisher acme --label zhangsan-laptop --auth-dir <dir>
 *    node scripts/gallery/token.mjs revoke --publisher acme --label zhangsan-laptop --auth-dir <dir>
 *    node scripts/gallery/token.mjs list [--publisher acme] --auth-dir <dir>
 *
 *  或:  pnpm gallery:token -- issue --publisher acme --label x --auth-dir <dir>
 *
 *  token 形如 uet_<base64url>，明文只在 issue 时打印一次（此后不可再查，只能吊销重发）；
 *  publishers.json 只存 sha256 哈希。server.mjs 按 mtime 自动重载，无需重启。
 *  运维签发的 publisher 直接落 status: 'active'（不受网页注册的审批门控约束）。
 *--------------------------------------------------------------------------------------------*/

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PUBLISHER_MAX_LEN,
  PUBLISHER_RE,
  issueToken,
  publisherStatus,
  writeJsonAtomic,
} from './lib.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    } else out._.push(a)
  }
  return out
}

function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}
function ok(msg) {
  console.log(`\x1b[32m✓ ${msg}\x1b[0m`)
}

const args = parseArgs(process.argv.slice(2))
const action = args._[0]

const authDirRaw = args['auth-dir'] ?? process.env.UE_SERVER_AUTH_DIR
if (!authDirRaw) die('缺少 --auth-dir <dir>（或 UE_SERVER_AUTH_DIR）——认证数据目录，须在服务器静态根之外')
const publishersFile = resolve(authDirRaw, 'publishers.json')

function load() {
  if (!existsSync(publishersFile)) return { publishers: [] }
  try {
    const data = JSON.parse(readFileSync(publishersFile, 'utf8'))
    if (!Array.isArray(data.publishers)) data.publishers = []
    return data
  } catch (err) {
    die(`publishers.json 不可解析: ${err.message} (${publishersFile})`)
  }
}

function requirePublisher() {
  const publisher = args.publisher
  if (!publisher) die('缺少 --publisher <name>')
  if (!PUBLISHER_RE.test(publisher) || publisher.length > PUBLISHER_MAX_LEN) {
    die(`publisher 名非法: ${publisher}（须匹配 ${PUBLISHER_RE} 且 ≤${PUBLISHER_MAX_LEN} 字符，与 uex login 校验一致）`)
  }
  return publisher
}

function requireLabel() {
  const label = args.label
  if (!label || label === true) die('缺少 --label <label>（token 归属备注，用于对账与定点吊销）')
  return String(label)
}

switch (action) {
  case 'issue': {
    const publisher = requirePublisher()
    const label = requireLabel()
    const data = load()
    let issued
    try {
      issued = issueToken(data, publisher, label)
    } catch (err) {
      die(err.message)
    }
    if (issued.created) ok(`已创建 publisher: ${publisher}`)
    writeJsonAtomic(publishersFile, data)
    ok(`已签发 token → ${publisher} / ${label}`)
    console.log(`\n  ${issued.token}\n`)
    console.log(`明文只打印这一次，此后不可再查（泄露只能 revoke 后重签）。`)
    console.log(`交付给开发者用于: uex login ${publisher} --registry <市场地址> --token <token>`)
    break
  }
  case 'revoke': {
    const publisher = requirePublisher()
    const label = requireLabel()
    const data = load()
    const entry = data.publishers.find((p) => p.name === publisher)
    const token = entry?.tokens.find((t) => t.label === label)
    if (!token) die(`未找到 token: ${publisher} / ${label}`)
    if (token.revoked) die(`token ${publisher} / ${label} 已于 ${token.revoked} 吊销`)
    token.revoked = new Date().toISOString()
    writeJsonAtomic(publishersFile, data)
    ok(`已吊销 ${publisher} / ${label}（server 按 mtime 自动重载，立即生效）`)
    break
  }
  case 'list': {
    const data = load()
    const filter = args.publisher && args.publisher !== true ? String(args.publisher) : null
    const rows = []
    for (const p of data.publishers) {
      if (filter && p.name !== filter) continue
      const status = publisherStatus(p)
      for (const t of p.tokens ?? []) {
        rows.push(
          `  ${p.name} [${status}]  ${t.label}  created=${t.created}  revoked=${t.revoked ?? '-'}`,
        )
      }
    }
    if (rows.length === 0) console.log('（无 token）')
    else console.log(rows.join('\n'))
    break
  }
  default:
    die(`未知动作: ${action ?? '(空)'}（支持 issue / revoke / list）`)
}
