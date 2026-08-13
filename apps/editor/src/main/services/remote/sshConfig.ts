/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Minimal ~/.ssh/config reader for surfacing connectable host names in the
 *  Remote-SSH command flow. Only what the picker needs: `Host` alias patterns
 *  (wildcard patterns are skipped — they are not concrete hosts) and one level of
 *  `Include` (a literal path, no glob expansion, and never recursed).
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Split a config line's argument list, honouring double quotes so `Host "a b"` stays one token. */
function tokenizeArgs(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of args) {
    if (ch === '"') {
      quoted = !quoted
    } else if (ch === ' ' || ch === '\t') {
      if (!quoted) {
        if (cur !== '') out.push(cur)
        cur = ''
        continue
      }
      cur += ch
    } else {
      cur += ch
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/** `Host` patterns in a config file body; wildcard patterns are dropped. */
export function parseSshHosts(configText: string): string[] {
  const hosts: string[] = []
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const space = line.search(/\s/)
    if (space === -1) continue
    const keyword = line.slice(0, space).toLowerCase()
    if (keyword !== 'host') continue
    for (const pattern of tokenizeArgs(line.slice(space).trim())) {
      if (pattern.includes('*') || pattern.includes('?')) continue
      hosts.push(pattern)
    }
  }
  return hosts
}

/** `Include` targets in a config file body. Glob patterns are skipped (no expansion). */
export function parseSshIncludes(configText: string): string[] {
  const includes: string[] = []
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const space = line.search(/\s/)
    if (space === -1) continue
    const keyword = line.slice(0, space).toLowerCase()
    if (keyword !== 'include') continue
    for (const target of tokenizeArgs(line.slice(space).trim())) {
      if (target.includes('*') || target.includes('?')) continue
      includes.push(target)
    }
  }
  return includes
}

function expandTilde(path: string, homeDir: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homeDir, path.slice(1))
  return path
}

/**
 * Connectable host names from `<homeDir>/.ssh/config` and one level of literal
 * `Include`s. Missing files are tolerated (empty result), mirroring ssh's own
 * behaviour of silently skipping absent config sources.
 */
export function listSshHosts(homeDir: string = homedir()): string[] {
  const mainPath = join(homeDir, '.ssh', 'config')
  let mainText: string
  try {
    mainText = readFileSync(mainPath, 'utf8')
  } catch {
    return []
  }
  const seen = new Set<string>()
  for (const host of parseSshHosts(mainText)) seen.add(host)
  for (const target of parseSshIncludes(mainText)) {
    let includedText: string
    try {
      includedText = readFileSync(expandTilde(target, homeDir), 'utf8')
    } catch {
      continue
    }
    for (const host of parseSshHosts(includedText)) seen.add(host)
  }
  return [...seen]
}
