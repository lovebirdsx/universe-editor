/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  tracker 配置读取。默认 ~/.config/universe-editor/tracker.json，可用 UE_TRACKER_CONFIG
 *  覆盖。凭据只在本进程内存里使用，绝不写日志 / stdout / stderr。
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const UNIFIED_STATUSES = ['open', 'planned', 'in_progress', 'done', 'closed']

const DEFAULT_ELIGIBLE = { labels: ['ai-ready'], statuses: ['planned'] }

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export function defaultConfigPath(env = process.env) {
  const override = env.UE_TRACKER_CONFIG?.trim()
  if (override) {
    const expanded = expandHome(override)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return join(homedir(), '.config', 'universe-editor', 'tracker.json')
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw new ConfigError(`配置字段 ${field} 必须是非空字符串`)
  }
  return value
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  return requireString(value, field)
}

function stringArray(value, field) {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new ConfigError(`配置字段 ${field} 必须是字符串数组`)
  }
  return value.map((item) => item.trim())
}

function normalizeEligible(value) {
  if (value === undefined) return { ...DEFAULT_ELIGIBLE }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('配置字段 eligible 必须是对象')
  }
  const labels = stringArray(value.labels, 'eligible.labels') ?? [...DEFAULT_ELIGIBLE.labels]
  const statuses = stringArray(value.statuses, 'eligible.statuses') ?? [
    ...DEFAULT_ELIGIBLE.statuses,
  ]
  for (const status of statuses) {
    if (!UNIFIED_STATUSES.includes(status)) {
      throw new ConfigError(
        `配置字段 eligible.statuses 含未知状态 ${status}（允许：${UNIFIED_STATUSES.join('/')}）`,
      )
    }
  }
  return { labels, statuses }
}

/**
 * 校验并补默认值。只返回可安全使用的对象；错误信息里不拼接 password。
 */
export function normalizeConfig(raw, { path } = {}) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('配置文件顶层必须是对象')
  }

  const adapter = requireString(raw.adapter ?? 'board', 'adapter')
  const baseUrl = requireString(raw.baseUrl, 'baseUrl')
  if (!isHttpUrl(baseUrl)) throw new ConfigError('配置字段 baseUrl 必须是 http(s) URL')

  const username = optionalString(raw.username, 'username')
  const password = optionalString(raw.password, 'password')
  if ((username === undefined) !== (password === undefined)) {
    throw new ConfigError('username 与 password 必须同时提供或同时省略')
  }

  const board = requireString(raw.board ?? 'universe-editor', 'board')
  const webUrl = optionalString(raw.webUrl, 'webUrl')
  if (webUrl !== undefined && !isHttpUrl(webUrl)) {
    throw new ConfigError('配置字段 webUrl 必须是 http(s) URL')
  }

  return {
    ...(path === undefined ? {} : { path }),
    adapter,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    ...(username === undefined ? {} : { username }),
    ...(password === undefined ? {} : { password }),
    board,
    ...(webUrl === undefined ? {} : { webUrl: webUrl.replace(/\/+$/, '') }),
    eligible: normalizeEligible(raw.eligible),
  }
}

export function loadConfig({ filePath, env = process.env } = {}) {
  const path = filePath ?? defaultConfigPath(env)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError(
      `无法读取 tracker 配置 ${path}: ${error?.code ?? error?.message ?? error}`,
    )
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`tracker 配置不是合法 JSON ${path}: ${error.message}`)
  }
  return normalizeConfig(raw, { path })
}
