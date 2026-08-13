/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the ~/.ssh/config reader backing Remote-SSH host completion.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listSshHosts, parseSshHosts, parseSshIncludes } from '../sshConfig.js'

const dirs: string[] = []

function makeHome(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ue2-ssh-'))
  dirs.push(dir)
  const sshDir = join(dir, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  for (const [name, content] of Object.entries(entries)) {
    writeFileSync(join(sshDir, name), content)
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseSshHosts', () => {
  it('collects Host patterns and skips comments / blank lines', () => {
    const hosts = parseSshHosts(`
# a comment
Host dev-box
  HostName 10.0.0.2

Host prod prod-alias
  HostName prod.example.com
`)
    expect(hosts).toEqual(['dev-box', 'prod', 'prod-alias'])
  })

  it('drops wildcard patterns and keeps quoted host names intact', () => {
    const hosts = parseSshHosts(`
Host *
  User default
Host *.example.com
Host "my host" plain
`)
    expect(hosts).toEqual(['my host', 'plain'])
  })
})

describe('parseSshIncludes', () => {
  it('collects literal Include targets and skips glob patterns', () => {
    const includes = parseSshIncludes(`
Include ~/.ssh/other
Include config.d/*.conf
`)
    expect(includes).toEqual(['~/.ssh/other'])
  })
})

describe('listSshHosts', () => {
  it('returns [] when ~/.ssh/config is missing', () => {
    const home = makeHome({})
    expect(listSshHosts(home)).toEqual([])
  })

  it('reads the main config and one level of Include, de-duplicated', () => {
    const home = makeHome({
      config: `
Host alpha
Host shared
Include ~/.ssh/work
`,
      work: `
Host beta
Host shared
Include ~/.ssh/nested   # must NOT be followed
`,
      nested: `
Host gamma
`,
    })
    expect(listSshHosts(home)).toEqual(['alpha', 'shared', 'beta'])
  })
})
