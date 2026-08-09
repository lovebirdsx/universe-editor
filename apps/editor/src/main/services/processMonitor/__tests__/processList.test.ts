/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/processMonitor/processList.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  findName,
  formatProcessList,
  listProcesses,
  type ProcessItem,
  type WinProcessListEntry,
} from '../processList.js'

describe('findName', () => {
  it('detects the electron crash reporter', () => {
    expect(findName('app.exe --crashes-directory=C:\\tmp\\crashes')).toBe('electron-crash-reporter')
  })

  it('detects the conpty agent', () => {
    expect(findName('C:\\Windows\\System32\\conhost.exe 0x4 --headless')).toBe('conpty-agent')
  })

  it('maps --type=renderer to window', () => {
    expect(findName('app.exe --type=renderer --js-flags=--max-old-space-size=4096')).toBe('window')
  })

  it('maps --type=utility with network sub-type to utility-network-service', () => {
    expect(findName('app.exe --type=utility --utility-sub-type=network.mojom.NetworkService')).toBe(
      'utility-network-service',
    )
  })

  it('maps other --type=utility to utility-process', () => {
    expect(findName('app.exe --type=utility --utility-sub-type=audio.mojom.AudioService')).toBe(
      'utility-process',
    )
  })

  it('maps --type=extensionHost to extension-host', () => {
    expect(findName('app.exe --type=extensionHost --skipWelcom')).toBe('extension-host')
  })

  it('passes through unknown --type values', () => {
    expect(findName('app.exe --type=gpu-process --gpu-preferences=x')).toBe('gpu-process')
  })

  it('detects tsserver and typingsInstaller', () => {
    expect(findName('node D:\\app\\tsserver.js --useInferredProjectPerProjectRoot')).toBe(
      'tsserver',
    )
    expect(findName('node D:\\app\\typingsInstaller.js --globalTypingsCacheLocation x')).toBe(
      'tsserver',
    )
  })

  it('detects ripgrep by exe name or bare binary path', () => {
    expect(findName('D:\\app\\node_modules\\ripgrep\\bin\\rg.exe --files')).toBe('ripgrep')
    expect(findName('/usr/local/bin/rg --files --hidden')).toBe('ripgrep')
  })

  it('collects .js filenames into electron-nodejs names', () => {
    expect(findName('D:\\app\\resources\\bootstrap.js --some-flag watcher.js')).toBe(
      'electron-nodejs (bootstrap.js watcher.js)',
    )
  })

  it('skips the .js scan for explicit node launches and returns the full cmd', () => {
    const cmd = 'node D:\\app\\server.js --port 3000'
    expect(findName(cmd)).toBe(cmd)
  })

  it('falls back to the full command line', () => {
    expect(findName('/usr/bin/zsh -l')).toBe('/usr/bin/zsh -l')
  })
})

describe('listProcesses (win32, injected source)', () => {
  const winEntries: WinProcessListEntry[] = [
    { pid: 100, ppid: 1, commandLine: '\\\\?\\C:\\app\\editor.exe', memory: 200 * 1024 * 1024 },
    { pid: 130, ppid: 100, commandLine: 'editor.exe --type=renderer', memory: 50 * 1024 * 1024 },
    { pid: 120, ppid: 100, commandLine: 'editor.exe --type=utility', memory: 40 * 1024 * 1024 },
    // orphan: parent 999 not in the list, must be dropped
    { pid: 140, ppid: 999, commandLine: 'stray.exe', memory: 1 },
  ]

  const winSource = {
    getProcessList: async () => winEntries,
    getProcessCpuUsage: async (list: readonly WinProcessListEntry[]) =>
      list.map((e) => ({ ...e, cpu: e.pid === 100 ? 7 : 3 })),
  }

  it('builds a sorted tree and drops orphans', async () => {
    const root = await listProcesses(100, new Map(), { platform: 'win32', win: winSource })

    expect(root.pid).toBe(100)
    expect(root.cmd).toBe('C:\\app\\editor.exe')
    expect(root.mem).toBe(200 * 1024 * 1024)
    expect(root.load).toBe(7)
    expect(root.children!.map((c) => c.pid)).toEqual([120, 130])
    expect(root.children![0]!.name).toBe('utility-process')
    expect(root.children![1]!.name).toBe('window')
  })

  it('rejects when the root pid is missing', async () => {
    await expect(
      listProcesses(42, new Map(), { platform: 'win32', win: winSource }),
    ).rejects.toThrow('Root process 42 not found')
  })

  it('propagates source failures', async () => {
    const failing = {
      getProcessList: async (): Promise<WinProcessListEntry[]> => {
        throw new Error('native boom')
      },
      getProcessCpuUsage: async () => [],
    }
    await expect(
      listProcesses(100, new Map(), { platform: 'win32', win: failing }),
    ).rejects.toThrow('native boom')
  })

  it('merges role info into name, role and roleLabel', async () => {
    const roles = new Map([
      [120, { role: 'pty-host' }],
      [130, { role: 'window', label: 'workbench' }],
    ])
    const root = await listProcesses(100, roles, { platform: 'win32', win: winSource })

    const utility = root.children!.find((c) => c.pid === 120)!
    expect(utility.name).toBe('pty-host')
    expect(utility.role).toBe('pty-host')
    expect(utility.roleLabel).toBeUndefined()

    const window = root.children!.find((c) => c.pid === 130)!
    expect(window.name).toBe('window (workbench)')
    expect(window.role).toBe('window')
    expect(window.roleLabel).toBe('workbench')

    expect(root.role).toBeUndefined()
  })
})

describe('listProcesses (unix, injected ps output)', () => {
  const psOutput = [
    '  100     1  2.5  1.0 /Applications/editor.app/Contents/MacOS/editor',
    '  120   100  0.0  0.5 editor --type=renderer',
    '  130   100 12.5  2.0 node /usr/lib/tsserver.js',
    '  140   999 99.9  9.9 /usr/bin/stray --orphan',
    'garbage line that does not parse',
    '',
  ].join('\n')

  const totalmem = () => 16 * 1024 ** 3

  it('parses ps output, converts pmem to bytes and drops orphans', async () => {
    const root = await listProcesses(100, new Map(), {
      platform: 'darwin',
      execPs: async () => psOutput,
      totalmem,
    })

    expect(root.pid).toBe(100)
    expect(root.load).toBe(2.5)
    expect(root.mem).toBeCloseTo((16 * 1024 ** 3 * 1.0) / 100)
    expect(root.children!.map((c) => c.pid)).toEqual([120, 130])
    expect(root.children![1]!.name).toBe('tsserver')
    expect(root.children![1]!.load).toBe(12.5)
  })

  it('rejects when the root pid is missing', async () => {
    await expect(
      listProcesses(7, new Map(), { platform: 'linux', execPs: async () => psOutput, totalmem }),
    ).rejects.toThrow('Root process 7 not found')
  })
})

describe('formatProcessList', () => {
  it('renders the VSCode-style aligned tree', () => {
    const root: ProcessItem = {
      name: 'editor',
      cmd: 'editor',
      pid: 100,
      ppid: 1,
      load: 2.5,
      mem: 200 * 1024 * 1024,
      children: [
        {
          name: 'window (workbench)',
          cmd: 'editor --type=renderer',
          pid: 130,
          ppid: 100,
          load: 0.4,
          mem: 50 * 1024 * 1024,
          role: 'window',
          roleLabel: 'workbench',
        },
        {
          name: 'utility-process',
          cmd: 'editor --type=utility',
          pid: 120,
          ppid: 100,
          load: 12.4,
          mem: 40.4 * 1024 * 1024,
          children: [
            {
              name: 'tsserver',
              cmd: 'node tsserver.js',
              pid: 121,
              ppid: 120,
              load: 0,
              mem: 1.6 * 1024 * 1024,
            },
          ],
        },
      ],
    }

    expect(formatProcessList(root)).toBe(
      [
        'CPU %\tMem MB\t   PID\tProcess',
        '    3\t   200\t   100\teditor',
        '    0\t    50\t   130\t  window (workbench)',
        '   12\t    40\t   120\t  utility-process',
        '    0\t     2\t   121\t    tsserver',
      ].join('\n'),
    )
  })
})
