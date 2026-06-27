/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Links this clone's Claude auto-memory directory to the repo-tracked
 *  `.claude-memory/` so memory is shared across all clones / worktrees of this
 *  repo and synced across machines via git.
 *
 *  Claude stores auto-memory under `~/.claude/projects/<cwd-encoded>/memory`,
 *  keyed by the absolute working-directory path — so every clone (and every
 *  machine) gets its own isolated memory. This script replaces that per-clone
 *  directory with a filesystem link (Windows junction / posix symlink, no admin
 *  needed) pointing at the repo's `.claude-memory/`.
 *
 *  Worktrees (Claude >= 2.1.63) redirect memory back to the main clone's global
 *  dir, so linking the main clone is enough; worktrees follow automatically.
 *
 *  Usage:
 *    node scripts/link-memory.mjs           # link this clone
 *    node scripts/link-memory.mjs --status  # show current link state, no changes
 *    node scripts/link-memory.mjs --force   # relink even if a link already exists
 *--------------------------------------------------------------------------------------------*/

import { homedir } from 'os'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const MEMORY_SOURCE = join(REPO_ROOT, '.claude', 'memory')

const args = new Set(process.argv.slice(2))
const STATUS_ONLY = args.has('--status')
const FORCE = args.has('--force')

// Claude encodes the cwd into the projects dir name: replace the drive colon,
// every path separator, and underscores with '-'. e.g.
//   D:\git_project\universe-editor2  ->  D--git-project-universe-editor2
//   /Users/me/universe_editor        ->  -Users-me-universe-editor
function encodeProjectDir(absPath) {
  return absPath.replace(/[:\\/_]/g, '-')
}

function fmt(p) {
  return p.replace(/\\/g, '/')
}

function describeLink(linkPath) {
  if (!existsSync(linkPath) && !isSymlinkLike(linkPath)) return { kind: 'missing' }
  const st = lstatSync(linkPath)
  if (st.isSymbolicLink()) {
    let target
    try {
      target = realpathSync(linkPath)
    } catch {
      target = readlinkSync(linkPath)
    }
    return { kind: 'link', target }
  }
  if (st.isDirectory()) {
    // A junction reports as a directory via lstat on Windows; resolve realpath
    // to tell a junction-to-source apart from a real local directory.
    let real
    try {
      real = realpathSync(linkPath)
    } catch {
      real = linkPath
    }
    if (resolve(real) !== resolve(linkPath)) return { kind: 'link', target: real }
    return { kind: 'dir', count: safeCount(linkPath) }
  }
  return { kind: 'other' }
}

function isSymlinkLike(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function safeCount(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md')).length
  } catch {
    return 0
  }
}

function pointsAtSource(target) {
  return resolve(target) === resolve(MEMORY_SOURCE)
}

function main() {
  if (!existsSync(MEMORY_SOURCE)) {
    console.error(`[link-memory] 找不到 memory 真身目录: ${fmt(MEMORY_SOURCE)}`)
    console.error('[link-memory] 期望它已在仓库中并纳入 git。')
    process.exit(1)
  }

  const projectsDir = join(homedir(), '.claude', 'projects')
  const encoded = encodeProjectDir(REPO_ROOT)
  const projectDir = join(projectsDir, encoded)
  const linkPath = join(projectDir, 'memory')

  console.log(`[link-memory] 仓库:        ${fmt(REPO_ROOT)}`)
  console.log(`[link-memory] memory 真身: ${fmt(MEMORY_SOURCE)}`)
  console.log(`[link-memory] 目标链接:    ${fmt(linkPath)}`)

  const current = describeLink(linkPath)

  if (current.kind === 'link') {
    const ok = pointsAtSource(current.target)
    console.log(
      `[link-memory] 现状: 已是链接 -> ${fmt(current.target)} ${ok ? '(已指向真身 ✓)' : '(指向他处 ✗)'}`,
    )
    if (STATUS_ONLY) return
    if (ok && !FORCE) {
      console.log('[link-memory] 无需变更。(用 --force 可强制重建)')
      return
    }
  } else if (current.kind === 'dir') {
    console.log(`[link-memory] 现状: 普通目录,含 ${current.count} 个 .md 文件`)
    if (STATUS_ONLY) return
  } else if (current.kind === 'missing') {
    console.log('[link-memory] 现状: 不存在')
    if (STATUS_ONLY) return
  } else {
    console.log(`[link-memory] 现状: ${current.kind}`)
    if (STATUS_ONLY) return
  }

  if (STATUS_ONLY) return

  // Safety: never silently destroy a real directory that holds memory files not
  // present in the repo source. Refuse and let the user merge manually.
  if (current.kind === 'dir' && current.count > 0) {
    const sourceFiles = new Set(readdirSync(MEMORY_SOURCE).filter((f) => f.endsWith('.md')))
    const orphan = readdirSync(linkPath)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !sourceFiles.has(f))
    if (orphan.length > 0) {
      console.error(
        `[link-memory] 拒绝覆盖: 该目录有 ${orphan.length} 个文件不在 .claude-memory 中:`,
      )
      orphan.forEach((f) => console.error(`  - ${f}`))
      console.error('[link-memory] 请先把它们合并进 .claude-memory/ 再重试。')
      process.exit(1)
    }
  }

  mkdirSync(projectDir, { recursive: true })

  if (current.kind !== 'missing') {
    rmSync(linkPath, { recursive: true, force: true })
  }

  // 'junction' on Windows needs no admin rights and works for dirs; posix uses
  // a normal dir symlink.
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(MEMORY_SOURCE, linkPath, type)

  const after = describeLink(linkPath)
  if (after.kind === 'link' && pointsAtSource(after.target)) {
    console.log('[link-memory] 完成 ✓ 链接已建立并指向 .claude/memory')
  } else {
    console.error('[link-memory] 链接创建后校验失败,请手动检查。')
    process.exit(1)
  }
}

main()
