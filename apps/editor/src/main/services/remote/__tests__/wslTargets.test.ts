/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/wslTargets.ts. The injected
 *  execFile returns plain strings — utf16le decoding happens at the encoding
 *  option layer, so fixtures don't need real UTF-16 bytes.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { listWslDistros, parseWslDistros, type WslExecFile } from '../wslTargets.js'

const VERBOSE = [
  '  NAME            STATE           VERSION',
  '* Ubuntu          Running         2',
  '  Debian          Stopped         2',
  '  docker-desktop  Running         2',
  '  docker-desktop-data  Running    2',
  '  Alpine          Stopped         1',
  '',
].join('\r\n')

describe('parseWslDistros', () => {
  it('parses names, default marker, versions and the running set', () => {
    const distros = parseWslDistros(VERBOSE, 'Ubuntu\r\n')
    expect(distros).toEqual([
      { name: 'Ubuntu', isDefault: true, isRunning: true, version: 2 },
      { name: 'Alpine', isDefault: false, isRunning: false, version: 1 },
      { name: 'Debian', isDefault: false, isRunning: false, version: 2 },
    ])
  })

  it('keeps both WSL1 and WSL2 distros', () => {
    const versions = parseWslDistros(VERBOSE, '').map((d) => d.version)
    expect(versions).toContain(1)
    expect(versions).toContain(2)
  })

  it('filters docker-desktop internals', () => {
    const names = parseWslDistros(VERBOSE, '').map((d) => d.name)
    expect(names).not.toContain('docker-desktop')
    expect(names).not.toContain('docker-desktop-data')
  })

  it('sorts the default distro first, the rest alphabetically', () => {
    const verbose = [
      '  NAME STATE VERSION',
      '  Zeta Stopped 2',
      '* Mid Running 2',
      '  Alpha Stopped 2',
    ].join('\n')
    expect(parseWslDistros(verbose, '').map((d) => d.name)).toEqual(['Mid', 'Alpha', 'Zeta'])
  })

  it('skips the header row regardless of column spacing and strips BOM/NULs', () => {
    const noisy = '\uFEFF' + VERBOSE.replace(/\n/g, '\n\0')
    const names = parseWslDistros(noisy, '').map((d) => d.name)
    expect(names).not.toContain('NAME')
    expect(names).toContain('Ubuntu')
  })

  it('skips a localized header via the NaN version guard', () => {
    const localized = ['  NOMBRE ESTADO VERSIÓN', '* Ubuntu Corriendo 2'].join('\n')
    expect(parseWslDistros(localized, '').map((d) => d.name)).toEqual(['Ubuntu'])
  })

  it('filters distros whose name is not a safe shell token', () => {
    const verbose = ['  NAME STATE VERSION', '* 发行版 Running 2', '  Ubuntu Stopped 2'].join('\n')
    expect(parseWslDistros(verbose, '').map((d) => d.name)).toEqual(['Ubuntu'])
  })

  it('skips rows with fewer than three columns', () => {
    const verbose = ['  NAME STATE VERSION', '  Broken 2', '  Ok Stopped 2'].join('\n')
    expect(parseWslDistros(verbose, '').map((d) => d.name)).toEqual(['Ok'])
  })
})

describe('listWslDistros', () => {
  it('runs --verbose and --running --quiet with utf16le + WSL_UTF8=0 and merges them', async () => {
    const calls: { args: readonly string[]; encoding: string; utf8Env: string | undefined }[] = []
    const execFile: WslExecFile = (_file, args, options) => {
      calls.push({ args, encoding: options.encoding, utf8Env: options.env['WSL_UTF8'] })
      return Promise.resolve(args.includes('--running') ? 'Debian\n' : VERBOSE)
    }
    const distros = await listWslDistros({ execFile, wslExePath: 'wsl.exe' })
    expect(calls.map((c) => [...c.args])).toEqual([
      ['--list', '--verbose'],
      ['--list', '--running', '--quiet'],
    ])
    expect(calls.every((c) => c.encoding === 'utf16le' && c.utf8Env === '0')).toBe(true)
    expect(distros.find((d) => d.name === 'Debian')?.isRunning).toBe(true)
    expect(distros.find((d) => d.name === 'Ubuntu')?.isRunning).toBe(false)
  })

  it('returns [] and logs when wsl.exe fails', async () => {
    const logs: string[] = []
    const execFile: WslExecFile = () => Promise.reject(new Error('boom'))
    const distros = await listWslDistros({
      execFile,
      wslExePath: 'wsl.exe',
      log: (m) => logs.push(m),
    })
    expect(distros).toEqual([])
    expect(logs.join('\n')).toContain('boom')
  })

  it('degrades to [] when wsl.exe is missing or every exec fails', async () => {
    const execFile: WslExecFile = () => Promise.reject(new Error('unavailable'))
    await expect(listWslDistros({ execFile })).resolves.toEqual([])
  })
})
