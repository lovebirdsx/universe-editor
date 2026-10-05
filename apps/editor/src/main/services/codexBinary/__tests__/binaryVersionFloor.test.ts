/*---------------------------------------------------------------------------------------------
 *  Tests for the runtime version floor on the two sources the download store
 *  never sees: a system/custom binary older than the version this build was
 *  validated against must be refused, while every uncertain case (unparseable
 *  output, a probe that cannot run, an unrecorded floor) fails open.
 *
 *  Fake binaries are shell scripts (POSIX) / `.cmd` shims (Windows) rather than
 *  `process.execPath`: node's `--version` does not exercise the agent banners a
 *  real binary prints, and `node` is not a stand-in for an agent.
 *--------------------------------------------------------------------------------------------*/

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbstractLogger, LogLevel, type ILoggerService } from '@universe-editor/platform'
import { CODEX_VERSION, codexFlavor } from '@universe-editor/node-services'
import { mkTempDir } from '@universe-editor/temp-root'

let userData = ''

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/fake/app',
    getPath: () => userData,
  },
}))

const { CodexBinaryMainService } = await import('../codexBinaryMainService.js')

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

async function makeTempDir(): Promise<string> {
  const dir = mkTempDir('universe-editor-codex-floor-')
  tempDirs.push(dir)
  return dir
}

/** A script that answers `--version` with `banner`, executable on this host. */
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

/** Runs `body` with `dir` prepended to PATH, so `which codex` finds the fixture. */
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

describe('CodexBinaryMainService — runtime version floor', () => {
  beforeEach(() => {
    userData = mkTempDir('universe-editor-codex-floor-data-')
    tempDirs.push(userData)
    logSink.length = 0
  })

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    vi.restoreAllMocks()
  })

  it('refuses a custom binary older than the pinned version', async () => {
    const dir = await makeTempDir()
    const binary = await writeFakeBinary(dir, 'codex', 'codex-cli 0.1.0')
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).rejects.toThrow(/0\.1\.0, older than the 0\.159\.1 this build requires/)
      // The refused path must name the ways out, not just the error.
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).rejects.toThrow(/acp\.codex\.executablePath/)
    } finally {
      svc.dispose()
    }
  })

  it('accepts a custom binary at the pinned version', async () => {
    const dir = await makeTempDir()
    const binary = await writeFakeBinary(dir, 'codex', `codex-cli ${CODEX_VERSION}`)
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).resolves.toEqual({
        path: binary,
      })
    } finally {
      svc.dispose()
    }
  })

  it('accepts a custom binary newer than the pinned version', async () => {
    const dir = await makeTempDir()
    const binary = await writeFakeBinary(dir, 'codex', 'codex-cli 0.160.0')
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).resolves.toEqual({
        path: binary,
      })
    } finally {
      svc.dispose()
    }
  })

  it('fails open when the reported version cannot be parsed', async () => {
    const dir = await makeTempDir()
    const binary = await writeFakeBinary(dir, 'codex', 'command not found')
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).resolves.toEqual({
        path: binary,
      })
      expect(logSink.some((m) => m.includes('could not read the version'))).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('fails open when the binary cannot be probed at all', async () => {
    const dir = await makeTempDir()
    const binary = path.join(dir, 'codex-not-executable')
    await writeFile(binary, 'codex-cli 0.1.0\n')
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'custom', customPath: binary, policy: 'pinned' }),
      ).resolves.toEqual({
        path: binary,
      })
      expect(logSink.some((m) => m.includes('could not read the version'))).toBe(true)
    } finally {
      svc.dispose()
    }
  })

  it('refuses an older system codex found on PATH', async () => {
    const dir = await makeTempDir()
    await writeFakeBinary(dir, 'codex', 'codex-cli 0.150.0')
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await withPrependedPath(dir, async () => {
        await expect(svc.resolve({ source: 'system', policy: 'pinned' })).rejects.toThrow(
          /0\.150\.0/,
        )
      })
    } finally {
      svc.dispose()
    }
  })

  it('resolves a system codex at the pinned version', async () => {
    const dir = await makeTempDir()
    const binary = await writeFakeBinary(dir, 'codex', `codex-cli ${CODEX_VERSION}`)
    const svc = new CodexBinaryMainService(loggerService)
    try {
      await withPrependedPath(dir, async () => {
        await expect(svc.resolve({ source: 'system', policy: 'pinned' })).resolves.toEqual({
          path: binary,
        })
      })
    } finally {
      svc.dispose()
    }
  })

  it('does not cache the below-pin fallback a background resolve returned', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'))
    const platform = codexFlavor.detectPlatform()
    const baseDir = path.join(userData, 'codex-bin')
    const stale = codexFlavor.binaryIn(path.join(baseDir, '0.1.0'), platform)
    await mkdir(path.dirname(stale), { recursive: true })
    await writeFile(stale, 'MZ')
    await writeFile(path.join(baseDir, '.active'), '0.1.0', 'utf8')

    const svc = new CodexBinaryMainService(loggerService)
    try {
      await expect(
        svc.resolve({ source: 'download', allowDownload: false, policy: 'manual' }),
      ).resolves.toEqual({
        path: stale,
      })

      // A foreground download (possibly another window) then installs the pin.
      const pinned = codexFlavor.binaryIn(path.join(baseDir, CODEX_VERSION), platform)
      await mkdir(path.dirname(pinned), { recursive: true })
      await writeFile(pinned, 'MZ')
      await writeFile(path.join(baseDir, '.active'), CODEX_VERSION, 'utf8')

      await expect(
        svc.resolve({ source: 'download', allowDownload: false, policy: 'manual' }),
      ).resolves.toEqual({
        path: pinned,
      })
    } finally {
      svc.dispose()
    }
  })
})
