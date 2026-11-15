#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  取数脚本：输出 main 上最近一次已完成 ci.yml run 失败时的 poll 数据。
 *
 *    node scripts/github/ci-failures.mjs
 *    node scripts/github/ci-failures.mjs --repo owner/repo --workflow ci.yml --branch main
 *
 *  poll 只关心「main 最新一条已完成 run 失败」。failure 直接输出；cancelled 只有在存在
 *  失败 job / 失败步骤时才输出（本仓库 fast-lint 失败后会 `gh run cancel`，顶层结论是
 *  cancelled）。success / skipped / 手动取消等不输出；最新 run 还在跑（含 rerun 中）时输出空，
 *  等它自己的结论，避免回落到更早的失败 run 白跑一轮。
 *  key 用 `<runId>:<attempt>`：rerun 后 attempt 变化，会以新 key 再次触发。
 *
 *  只用 node 内置模块；gh 只负责取数，错误写 stderr、非零退出。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_WORKFLOW = 'ci.yml'
export const DEFAULT_BRANCH = 'main'
export const DEFAULT_LIMIT = 20

const FAILED_JOB_LIMIT = 20
const GH_MAX_BUFFER = 32 * 1024 * 1024
// ci.yml 的 required-check 哨兵：其它 job 失败或被取消时它也失败，本身不代表失败面。
// 手动取消整条 run 时可能只有它失败，不能据此唤醒修复 agent。
const GATE_JOB_NAME = 'CI Gate'

export function defaultRunGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: GH_MAX_BUFFER,
    windowsHide: true,
  })
  if (result.error) throw new Error(`无法执行 gh: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim()
    throw new Error(`gh ${args.join(' ')} 失败${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} 输出不是合法 JSON: ${error.message}`)
  }
}

export function parseRepoFromRemote(remote) {
  const text = String(remote ?? '').trim()
  const patterns = [
    /^(?:https?|ssh):\/\/(?:[^@/]+@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@/\s]+@)?[^:/\s]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const repo = `${match[1]}/${match[2]}`
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return repo
  }
  throw new Error(`无法从 origin 解析 <owner>/<repo>: ${text}`)
}

function compareRunsDesc(a, b) {
  const left = Date.parse(a.createdAt ?? '')
  const right = Date.parse(b.createdAt ?? '')
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return right - left
  const idDiff = (Number(b.runId) || 0) - (Number(a.runId) || 0)
  if (idDiff !== 0) return idDiff
  return (Number(b.attempt) || 0) - (Number(a.attempt) || 0)
}

function normalizeRun(raw) {
  return {
    runId: Number(raw.databaseId),
    attempt: Number(raw.attempt) || 1,
    status: raw.status,
    conclusion: raw.conclusion,
    headSha: raw.headSha,
    title: raw.displayTitle ?? raw.name ?? '',
    url: raw.url,
    createdAt: raw.createdAt,
    event: raw.event,
  }
}

/**
 * 最新一条 run（按 createdAt）必须是 completed；还在排队 / 运行时不回落到更早的 run。
 */
export function selectLatestCompletedRun(runs) {
  if (!Array.isArray(runs)) throw new Error('run 列表必须是数组')
  const latest = runs
    .filter((run) => run !== null && typeof run === 'object')
    .map(normalizeRun)
    .sort(compareRunsDesc)[0]
  if (latest === undefined || latest.status !== 'completed') return undefined
  return latest
}

/**
 * 只返回顶层结论为 failure 的最新 run；cancelled 的判定需要 jobs 细节，由
 * collectFailures() 处理。
 */
export function selectFailures(runs) {
  const latest = selectLatestCompletedRun(runs)
  return latest !== undefined && latest.conclusion === 'failure' ? [latest] : []
}

export function buildPollItem(run) {
  return {
    id: `${run.runId}:${run.attempt}`,
    runId: run.runId,
    attempt: run.attempt,
    headSha: run.headSha,
    title: run.title,
    url: run.url,
    createdAt: run.createdAt,
    ...(run.event === undefined ? {} : { event: run.event }),
  }
}

export function fetchRuns({
  repo,
  workflow = DEFAULT_WORKFLOW,
  branch = DEFAULT_BRANCH,
  limit = DEFAULT_LIMIT,
  runGh = defaultRunGh,
}) {
  const stdout = runGh([
    'run',
    'list',
    '--repo',
    repo,
    '--workflow',
    workflow,
    '--branch',
    branch,
    '--limit',
    String(limit),
    '--json',
    'databaseId,attempt,status,conclusion,headSha,displayTitle,url,createdAt,event',
  ])
  const parsed = parseJson(stdout, 'gh run list')
  if (!Array.isArray(parsed)) throw new Error('gh run list 输出必须是数组')
  return parsed
}

/**
 * 汇总失败 job 与失败步骤。cancelled 的 job 也可能带着真实失败：本仓库 fast-lint 的
 * guard 失败后会 `gh run cancel`，job 自身结论变成 cancelled，失败步骤仍是 failure。
 */
export function collectRunFailureDetails(jobs) {
  if (!Array.isArray(jobs)) throw new Error('jobs 必须是数组')
  const failedJobs = []
  const failedSteps = []
  for (const job of jobs) {
    if (job === null || typeof job !== 'object') continue
    const jobName = typeof job.name === 'string' && job.name !== '' ? job.name : undefined
    if (jobName === undefined) continue
    const steps = Array.isArray(job.steps) ? job.steps : []
    const stepFailures = steps.filter(
      (step) => step !== null && typeof step === 'object' && step.conclusion === 'failure',
    )
    if (job.conclusion === 'failure' || stepFailures.length > 0) failedJobs.push(jobName)
    for (const step of stepFailures) {
      if (typeof step.name === 'string' && step.name !== '') {
        failedSteps.push(`${jobName}: ${step.name}`)
      }
    }
  }
  const uniqueJobs = [...new Set(failedJobs)]
  const uniqueSteps = [...new Set(failedSteps)]
  return {
    hasFailure: uniqueJobs.some((name) => name !== GATE_JOB_NAME),
    details: {
      failedJobs: uniqueJobs.slice(0, FAILED_JOB_LIMIT),
      failedJobCount: uniqueJobs.length,
      ...(uniqueSteps.length === 0 ? {} : { failedSteps: uniqueSteps.slice(0, FAILED_JOB_LIMIT) }),
    },
  }
}

export function fetchRunFailures({ repo, runId, runGh = defaultRunGh }) {
  const stdout = runGh(['run', 'view', String(runId), '--repo', repo, '--json', 'jobs'])
  const parsed = parseJson(stdout, 'gh run view')
  if (!Array.isArray(parsed?.jobs)) throw new Error('gh run view 输出缺少 jobs 数组')
  return collectRunFailureDetails(parsed.jobs)
}

export function collectFailures({
  repo,
  workflow = DEFAULT_WORKFLOW,
  branch = DEFAULT_BRANCH,
  limit = DEFAULT_LIMIT,
  runGh = defaultRunGh,
  stderr = process.stderr,
}) {
  const runs = fetchRuns({ repo, workflow, branch, limit, runGh })
  const latest = selectLatestCompletedRun(runs)
  if (latest === undefined) return []
  const topLevelFailure = latest.conclusion === 'failure'
  if (!topLevelFailure && latest.conclusion !== 'cancelled') return []

  let failures
  try {
    failures = fetchRunFailures({ repo, runId: latest.runId, runGh })
  } catch (error) {
    if (topLevelFailure) {
      // 失败 job 列表只是诊断线索，取不到不影响触发；skill 会用日志兜底。
      stderr.write(`[ci-failures] 无法获取失败 job 列表: ${error.message}\n`)
      return [buildPollItem(latest)]
    }
    // 取消的 run 没有 job 细节就无法区分 guard 失败与手动取消，宁可跳过。
    stderr.write(`[ci-failures] 无法获取 job 列表，取消的 run 按无需处理跳过: ${error.message}\n`)
    return []
  }
  if (!topLevelFailure && !failures.hasFailure) return []
  return [{ ...buildPollItem(latest), ...failures.details }]
}

export function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--repo') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--'))
        throw new Error('--repo 需要 <owner>/<repo>')
      options.repo = value
    } else if (arg === '--workflow') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--workflow 需要文件名')
      options.workflow = value
    } else if (arg === '--branch') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--branch 需要分支名')
      options.branch = value
    } else if (arg === '--limit') {
      const value = argv[++i]
      if (value === undefined) throw new Error('--limit 需要数字')
      const number = Number(value)
      if (!Number.isInteger(number) || number < 1 || number > 100) {
        throw new Error('--limit 必须是 1..100 的整数')
      }
      options.limit = number
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return options
}

function usage() {
  process.stdout.write(
    [
      '用法: node scripts/github/ci-failures.mjs [选项]',
      '  --repo <owner/repo>  GitHub 仓库（默认从 git remote get-url origin 解析）',
      '  --workflow <file>    workflow 文件名（默认 ci.yml）',
      '  --branch <branch>    分支（默认 main）',
      '  --limit <n>          拉取最近 n 条 run（默认 20，最多 100）',
      '',
    ].join('\n'),
  )
}

function readOriginRepo({ cwd = process.cwd(), runGit = defaultRunGit } = {}) {
  const remote = runGit(['remote', 'get-url', 'origin'], { cwd }).trim()
  return parseRepoFromRemote(remote)
}

function defaultRunGit(args, { cwd }) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw new Error(`无法执行 git: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim()
    throw new Error(`git ${args.join(' ')} 失败${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout
}

export function main(
  argv = process.argv.slice(2),
  { runGh = defaultRunGh, runGit = defaultRunGit, cwd = process.cwd() } = {},
) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`[ci-failures] ${error.message}\n`)
    process.exitCode = 1
    return
  }

  if (options.help) {
    usage()
    return
  }

  try {
    const repo = options.repo ?? readOriginRepo({ cwd, runGit })
    const failures = collectFailures({
      repo,
      workflow: options.workflow ?? DEFAULT_WORKFLOW,
      branch: options.branch ?? DEFAULT_BRANCH,
      limit: options.limit ?? DEFAULT_LIMIT,
      runGh,
    })
    process.stdout.write(`${JSON.stringify(failures)}\n`)
  } catch (error) {
    process.stderr.write(`[ci-failures] ${error.message}\n`)
    process.exitCode = 1
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) main()
