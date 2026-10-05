/*---------------------------------------------------------------------------------------------
 *  Tests for the runtime version floor on the two sources the download store
 *  never sees. Claude is the interesting one: the pinned version names the SDK
 *  package, while a binary self-reports its CLI version — different namespaces,
 *  so the floor comes from `cliVersion`, sampled into claude-binary.json at
 *  build time, and its absence must fail open rather than guess.
 *
 *  Fake binaries are shell scripts (POSIX) / `.cmd` shims (Windows). The
 *  custom/system cases are skipped on Windows: `selectClaudeExecutable` only
 *  accepts a native `claude.exe` there, which a fixture script cannot be.
 *--------------------------------------------------------------------------------------------*/

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbstractLogger, LogLevel, type ILoggerService } from '@universe-editor/platform'
import { mkTempDir } from '@universe-editor/temp-root'

let userData = ''
let appRoot = ''
let fixtureRoot = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appRoot,
    getPath: () => userData,
  },
}))

const { ClaudeBinaryMainService } = await import('../claudeBinaryMainService.js')

const SDK_VERSION = '0.3.220'
const CLI_VERSION = '2.1.220'

const logSink: string[] = []

class RecordingLogger extends AbstractLogger {
  protected override _log(_level: LogLevel, message: string): void {
    logSink.push(message)
  }
}

const loggerService: ILoggerService = {
  _serviceBrand: undefined,
  createLogger: () => new RecordingLogger(),
  setLevel: () => {},
  getLevel: () => LogLevel.Info,
}

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = mkTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

/** The build-time meta the flavor reads; `cliVersion` may be omitted on purpose. */
async function writeMeta(meta: Record<string, unknown>): Promise<void> {
  const dir = path.join(fixtureRoot, 'vendor', 'claude-agent-acp', 'dist')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'claude-binary.json'), JSON.stringify(meta))
}

async function writeFakeBinary(dir: string, name: string, banner: string): Promise<string> {
  if (process.platform === 'win32') {
    const file = path.join(dir, `${name}.cmd`)
    await writeFile(file, `@echo off\r\necho ${banner}\r\n`)
    return file
  }
  const file = path.join(dir, name)
  await writeFile(file, `#!/bin/sh\necho '${banner}'\n`)
  await chmod(file, 0o755)
  return file
}

/** Runs `body` with `dir` prepended to PATH, so `which claude` finds the fixture. */
async function withPrependedPath(dir: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env['PATH']
  process.env['PATH'] = `${dir}${path.delimiter}${previous ?? ''}`
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env['PATH']
    else process.env['PATH'] = previous
  }
}

describe('ClaudeBinaryMainService — runtime version floor', () => {
  beforeEach(async () => {
    userData = await makeTempDir('universe-editor-claude-floor-data-')
    fixtureRoot = await makeTempDir('universe-editor-claude-floor-app-')
    appRoot = path.join(fixtureRoot, 'apps', 'editor')
    await mkdir(appRoot, { recursive: true })
    await writeMeta({ sdkVersion: SDK_VERSION, cliVersion: CLI_VERSION })
    logSink.length = 0
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a custom binary whose CLI version is older than the build-time floor',
    async () => {
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      const binary = await writeFakeBinary(dir, 'claude', '2.1.100 (Claude Code)')
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        // The CLI version is compared, never the SDK pin — 2.1.100 is *above*
        // 0.3.220 numerically and must still be refused.
        await expect(svc.resolve({ source: 'custom', customPath: binary })).rejects.toThrow(
          /2\.1\.100, older than the 2\.1\.220 this build requires/,
        )
        await expect(svc.resolve({ source: 'custom', customPath: binary })).rejects.toThrow(
          /acp\.claude\.executablePath/,
        )
      } finally {
        svc.dispose()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'accepts a custom binary at or above the build-time floor',
    async () => {
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      const atFloor = await writeFakeBinary(dir, 'claude', `${CLI_VERSION} (Claude Code)`)
      const newer = await writeFakeBinary(dir, 'claude-newer', '2.1.300 (Claude Code)')
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        await expect(svc.resolve({ source: 'custom', customPath: atFloor })).resolves.toEqual({
          path: atFloor,
        })
        await expect(svc.resolve({ source: 'custom', customPath: newer })).resolves.toEqual({
          path: newer,
        })
      } finally {
        svc.dispose()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'fails open when the reported version cannot be parsed',
    async () => {
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      const binary = await writeFakeBinary(dir, 'claude', 'command not found')
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        await expect(svc.resolve({ source: 'custom', customPath: binary })).resolves.toEqual({
          path: binary,
        })
        expect(logSink.some((m) => m.includes('could not read the version'))).toBe(true)
      } finally {
        svc.dispose()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'skips the check entirely when the meta file records no CLI version',
    async () => {
      // An older meta file (pre-`cliVersion`) or a build machine that could not
      // run the probe: the floor is unknown, and an unknown floor never blocks.
      await writeMeta({ sdkVersion: SDK_VERSION })
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      const binary = await writeFakeBinary(dir, 'claude', '2.1.100 (Claude Code)')
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        await expect(svc.resolve({ source: 'custom', customPath: binary })).resolves.toEqual({
          path: binary,
        })
        expect(logSink.some((m) => m.includes('no CLI version was recorded'))).toBe(true)
      } finally {
        svc.dispose()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses an older system claude found on PATH',
    async () => {
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      await writeFakeBinary(dir, 'claude', '2.0.0 (Claude Code)')
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        await withPrependedPath(dir, async () => {
          await expect(svc.resolve({ source: 'system' })).rejects.toThrow(/2\.0\.0.*2\.1\.220/)
        })
      } finally {
        svc.dispose()
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'resolves a system claude at the build-time floor',
    async () => {
      const dir = await makeTempDir('universe-editor-claude-floor-bin-')
      const binary = await writeFakeBinary(dir, 'claude', `${CLI_VERSION} (Claude Code)`)
      const svc = new ClaudeBinaryMainService(loggerService)
      try {
        await withPrependedPath(dir, async () => {
          await expect(svc.resolve({ source: 'system' })).resolves.toEqual({ path: binary })
        })
      } finally {
        svc.dispose()
      }
    },
  )
})
