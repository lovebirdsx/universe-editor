#!/usr/bin/env node
/**
 * 导入外部机器的 Claude Code 原生 session jsonl，让本机 universe-editor 能加载。
 *
 * 用法：
 *   node import-session.mjs <src.jsonl> <targetWorkspaceCwd> [选项]
 *
 * 选项：
 *   --title <标题>        在文件头注入 summary 行（会话列表标题；SDK 可能仍按自己的摘要覆盖）
 *   --branch <分支名>     改写 gitBranch 字段（默认：自动读目标目录的 git 分支，失败则保持不变）
 *   --keep-timestamps     不把最后一条消息的 timestamp 拨到现在（见下方「为什么要拨时间」）
 *   --force               目标文件已存在时允许覆盖
 *
 * 为什么要拨时间（默认行为）：编辑器会话历史按 lastUsedAt 降序只保留 MAX_ENTRIES=100 条，
 * lastUsedAt 取自会话最后一条真实消息的 timestamp。如果导入的会话比现存最老条目还旧，
 * merge 后立刻被淘汰、列表里永远看不到。把最后一条消息的 timestamp 拨到现在即可逃过截断。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const positional = []
let title
let branch
let keepTimestamps = false
let force = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--title') title = args[++i]
  else if (a === '--branch') branch = args[++i]
  else if (a === '--keep-timestamps') keepTimestamps = true
  else if (a === '--force') force = true
  else positional.push(a)
}

if (positional.length !== 2) {
  console.error('用法: node import-session.mjs <src.jsonl> <targetWorkspaceCwd> [--title T] [--branch B] [--keep-timestamps] [--force]')
  process.exit(1)
}
const [src, rawCwd] = positional

// cwd 规范化：绝对路径 + Windows 盘符大写（与本地会话的存储格式一致）
const targetCwd = path.resolve(rawCwd).replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':')
const slug = targetCwd.replace(/[^a-zA-Z0-9]/g, '-')
const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const sessionId = path.basename(src, '.jsonl')
const dstDir = path.join(claudeConfigDir, 'projects', slug)
const dst = path.join(dstDir, `${sessionId}.jsonl`)

if (!fs.existsSync(src)) {
  console.error(`源文件不存在: ${src}`)
  process.exit(1)
}
if (fs.existsSync(dst) && !force) {
  console.error(`目标已存在（用 --force 覆盖）: ${dst}`)
  process.exit(1)
}
if (branch === undefined) {
  try {
    branch = execFileSync('git', ['-C', targetCwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    branch = undefined
  }
}

const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim().length > 0)
const uuids = new Set()
for (const l of lines) {
  const o = JSON.parse(l)
  if (o.uuid) uuids.add(o.uuid)
}

let msgCount = 0
let cwdRewritten = 0
let noUuid = 0
let brokenChain = 0
let lastMsgIdx = -1
let lastMsgUuid = null
const out = []
for (let i = 0; i < lines.length; i++) {
  const o = JSON.parse(lines[i])
  if (typeof o.cwd === 'string' && o.cwd !== targetCwd) {
    o.cwd = targetCwd
    cwdRewritten++
  }
  if (branch && o.gitBranch) o.gitBranch = branch
  if (o.type === 'user' || o.type === 'assistant') {
    msgCount++
    if (!o.uuid) noUuid++
    if (o.parentUuid && !uuids.has(o.parentUuid)) brokenChain++
    if (o.uuid) {
      lastMsgIdx = out.length
      lastMsgUuid = o.uuid
    }
  }
  out.push(JSON.stringify(o))
}

if (msgCount === 0) {
  console.error('源文件没有任何 user/assistant 消息行，不像 Claude Code session 文件')
  process.exit(1)
}
if (noUuid > 0) console.warn(`警告: ${noUuid} 条消息行缺 uuid，agent 重放时会跳过`)
if (brokenChain > 0) console.warn(`警告: ${brokenChain} 处 parentUuid 指向不存在的消息，历史链可能断裂`)

if (!keepTimestamps && lastMsgIdx >= 0) {
  const o = JSON.parse(out[lastMsgIdx])
  o.timestamp = new Date().toISOString()
  out[lastMsgIdx] = JSON.stringify(o)
}
if (title) {
  out.unshift(JSON.stringify({ type: 'summary', summary: title, leafUuid: lastMsgUuid }))
}

fs.mkdirSync(dstDir, { recursive: true })
fs.writeFileSync(dst, out.join('\n') + '\n')

console.log('导入完成:')
console.log(`  输出: ${dst}`)
console.log(`  行数: ${out.length}（消息 ${msgCount} 条，cwd 改写 ${cwdRewritten} 行）`)
if (branch) console.log(`  gitBranch → ${branch}`)
if (!keepTimestamps) console.log('  最后一条消息 timestamp 已拨到现在（逃过 MAX_ENTRIES=100 截断）')
console.log('下一步: 在编辑器里打开该工作区 → Agents 视图 → 刷新，会话应出现在列表顶部')
