/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  check-sensitive-strings.mjs — 阻止内部标识重新进入仓库。
 *
 *  这是本仓库公开的前提：内部服务域名、公司/项目代号、私网地址、开发者本机路径
 *  与账号名都不得出现在源码、测试固定值或文档里。占位值统一走 RFC 保留段
 *  （RFC 2606 的 example.com / RFC 5737 的 192.0.2.0/24），扫描器普遍识别为
 *  非真实地址，不会被再次判定为泄露。
 *
 *  Usage:
 *    node scripts/check-sensitive-strings.mjs           # 报告，exit 0
 *    node scripts/check-sensitive-strings.mjs --check   # CI：命中即 exit 1
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.slice(2).includes('--check')

/** 不扫描的目录：构建产物、依赖、vendor fork、gitignore 的本机文件。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'dist-bundle',
  'out',
  'out-dev',
  'release',
  'coverage',
  'market-stage',
  'playwright-report',
  'test-results',
  '.next',
  // vendor fork 与外部扩展有各自的上游来源，不在本仓库整改范围
  'vendor',
  'extensions-external',
  // gitignore 的本机产物：不进公开仓库
  'plans',
  'explore-results',
  'handoff',
])

/** 只扫文本源码与文档；二进制与锁文件跳过。 */
const SCAN_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
  '.sh',
  '.ps1',
  '.html',
  '.css',
  '.example',
])

/** 无扩展名但需要扫的文件。 */
const SCAN_NAMES = new Set(['.env.example', 'Dockerfile'])

const SKIP_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'settings.local.json', // gitignore 的本机配置
])

/**
 * 每条规则：命中即失败。
 *
 * `allow` 是同行豁免——只用于「该模式在此行确实是无害巧合」的情况，
 * 不要用它给真实的内部标识开后门。
 */
const RULES = [
  {
    id: 'internal-domain',
    desc: '内部服务域名（占位请用 *.example.com）',
    re: /\b(?:[a-z0-9-]+\.)*(?:kuro|kurogames)\.com\b/gi,
  },
  {
    id: 'company-codename',
    desc: '公司代号（provider id / TOML 段名 / 凭据前缀请用 acme）',
    // 不用 \b 收尾：`_` 是 word 字符，会漏掉 kuro_gateway 这类形态
    re: /\bkuro(?:games)?/gi,
  },
  {
    id: 'internal-system-codename',
    desc: '内部系统代号 iloop（问题上报服务统一叫 tracker）',
    re: /\biloop/gi,
  },
  {
    id: 'project-codename',
    desc: '项目代号 aki（depot 路径 / 工作区名请用 depot）',
    // `aki` 作为独立标识符：后接分隔符、行尾，或驼峰接大写。
    // 不能只列举 aki_数字 / aki_branch 这类已知形态——曾漏掉 //aki_ws、D:/x/aki 等。
    // 英文词（making/taking/flakiness…）靠 wordBoundaryBefore 的负向前瞻排除。
    re: /(?<![a-z])aki(?=[_/\-.\s'"`)\]]|$)|\bAki[A-Z]/gi,
  },
  {
    id: 'private-ip',
    desc: '私网地址（占位请用 RFC 5737 的 192.0.2.x）',
    // RFC 1918 私网三段 + CGNAT。带端口或不带都算。
    // 无需给版本号开豁免：四段版本（10.0.19041.3636）第三段超 3 位、
    // 三段版本（^10.0.0）段数不足，都匹配不上。整行豁免更危险——
    // 同行出现 "node 10.24" 会把真实的 10.0.0.1 一并放行。
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'local-drive-path',
    desc: '开发者本机盘符路径（占位请用 X:/workspace 或 X:/p4ws）',
    // 盘符 + 常见个人工作目录名。只列真实出现过的形态，避免误伤 C:/Program Files 之类合法示例。
    re: /\b[a-z]:[\\/](?:git_project|cloud-storage)\b/gi,
  },
  {
    id: 'real-username',
    desc: '真实账号名 / 机器名（占位请用 testuser、dev、DESKTOP-TEST）',
    // 不用 \b 收尾：`_` 是 word 字符，`\bsongxiao\b` 匹配不到 songxiao_depot_branch
    re: /(?:songxiao|huangjunji|zouwei|huyunjun|linzhenqun|DESKTOP-KURO)/gi,
  },
  {
    id: 'user-home-realname',
    desc: '本机用户目录里的真实账号名（占位请用 testuser / dev）',
    // 只在 Users\ 或 /home/ 后面判定，避免误伤同名的普通标识符
    re: /(?:[Uu]sers[\\/]|\/home\/)(?:kuro|xiao)\b/g,
  },
  {
    id: 'hr-document-path',
    desc: '内部 HR 文档路径（示例请用中性中文目录名）',
    re: /个人考核/g,
  },
  {
    id: 'internal-depot-layout',
    desc: '内部工程目录布局 / 业务文件名',
    re: /\b(?:Source\/Client\/TypeScript|PosTransfer)\b/g,
  },
]

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(join(dir, entry.name), files)
      continue
    }
    if (!entry.isFile()) continue
    if (SKIP_FILES.has(entry.name)) continue
    if (SCAN_NAMES.has(entry.name) || SCAN_EXTS.has(extname(entry.name))) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

/** 本文件自身列举了所有敏感模式，扫自己必然全中。 */
function isSelf(file) {
  return file === fileURLToPath(import.meta.url)
}

function scan(file) {
  const hits = []
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    return hits
  }
  // 极长单行通常是内联的 base64 / minified 资源，跳过以免误报
  const lines = source.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.length > 2000) return
    if (line.includes('sensitive-strings:allow')) return
    for (const rule of RULES) {
      if (rule.allow?.some((a) => a.test(line))) continue
      rule.re.lastIndex = 0
      for (const m of line.matchAll(rule.re)) {
        // allowMatch 只看命中片段，避免同行的无关内容把真实泄漏一并豁免
        if (rule.allowMatch?.some((a) => a.test(m[0]))) continue
        hits.push({ line: i + 1, rule, match: m[0] })
      }
    }
  })
  return hits
}

function main() {
  const files = collectFiles(REPO_ROOT).filter((f) => !isSelf(f))
  const findings = []

  for (const file of files) {
    for (const hit of scan(file)) {
      findings.push({ file: relative(REPO_ROOT, file).replace(/\\/g, '/'), ...hit })
    }
  }

  if (findings.length === 0) {
    console.log(`[sensitive-strings] ${files.length} 个文件，未发现内部标识 ✓`)
    return
  }

  console.error(`[sensitive-strings] 发现 ${findings.length} 处内部标识：`)
  const byRule = new Map()
  for (const f of findings) {
    if (!byRule.has(f.rule.id)) byRule.set(f.rule.id, [])
    byRule.get(f.rule.id).push(f)
  }
  for (const [id, items] of byRule) {
    console.error(`\n  ${id} — ${items[0].rule.desc}`)
    for (const it of items) {
      console.error(`    ${it.file}:${it.line}  ${it.match}`)
    }
  }
  console.error(
    '\n  占位规范：域名 *.example.com（RFC 2606）；IP 192.0.2.x（RFC 5737）；' +
      '代号 acme / depot / tracker；本机路径 X:/workspace；账号 testuser / dev。' +
      '\n  确认某行是无害巧合时，可在该行加 `sensitive-strings:allow` 注释豁免。',
  )
  if (CHECK_ONLY) process.exit(1)
}

main()
