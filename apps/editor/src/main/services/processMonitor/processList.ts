/*---------------------------------------------------------------------------------------------
 *  Process tree collection, ported from VSCode src/vs/base/node/ps.ts.
 *  The native @vscode/windows-process-tree module is loaded lazily via
 *  createRequire so non-Windows platforms and unit tests never touch it.
 *--------------------------------------------------------------------------------------------*/

import { exec } from 'node:child_process'
import { createRequire } from 'node:module'
import { totalmem as osTotalmem } from 'node:os'

export interface ProcessItem {
  name: string
  cmd: string
  pid: number
  ppid: number
  load: number
  mem: number
  role?: string
  roleLabel?: string
  children?: ProcessItem[]
}

export interface ProcessRoleInfo {
  role: string
  label?: string
}

export interface WinProcessListEntry {
  pid: number
  ppid: number
  commandLine?: string
  memory?: number
  cpu?: number
}

export interface WindowsProcessSource {
  getProcessList(rootPid: number): Promise<WinProcessListEntry[]>
  getProcessCpuUsage(list: readonly WinProcessListEntry[]): Promise<WinProcessListEntry[]>
}

export interface ProcessListDeps {
  platform?: NodeJS.Platform
  win?: WindowsProcessSource
  execPs?: () => Promise<string>
  totalmem?: () => number
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const MB = 1024 * 1024

type WindowsProcessTreeModule = typeof import('@vscode/windows-process-tree')
type NativeProcessInfo = import('@vscode/windows-process-tree').IProcessInfo

const requireFromHere = createRequire(import.meta.url)

let cachedWpt: WindowsProcessTreeModule | undefined

function loadWindowsProcessTree(): WindowsProcessTreeModule {
  if (!cachedWpt) {
    cachedWpt = requireFromHere('@vscode/windows-process-tree') as WindowsProcessTreeModule
  }
  return cachedWpt
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

function defaultWindowsSource(timeoutMs: number): WindowsProcessSource {
  const wpt = loadWindowsProcessTree()
  const flags = wpt.ProcessDataFlag.CommandLine | wpt.ProcessDataFlag.Memory
  return {
    getProcessList: (rootPid) =>
      withTimeout(
        new Promise<WinProcessListEntry[]>((resolve, reject) => {
          wpt.getProcessList(
            rootPid,
            (list) => {
              if (!list) {
                reject(new Error(`Root process ${rootPid} not found`))
              } else {
                resolve(list)
              }
            },
            flags,
          )
        }),
        timeoutMs,
        'getProcessList',
      ),
    getProcessCpuUsage: (list) =>
      withTimeout(
        new Promise<WinProcessListEntry[]>((resolve) => {
          wpt.getProcessCpuUsage([...list] as NativeProcessInfo[], (withCpu) => resolve(withCpu))
        }),
        timeoutMs,
        'getProcessCpuUsage',
      ),
  }
}

function defaultExecPs(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    exec(
      'ps -ax -o pid=,ppid=,pcpu=,pmem=,command=',
      {
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_NUMERIC: 'en_US.UTF-8' },
      },
      (err, stdout, stderr) => {
        // Silently ignoring the screen size is bogus error, microsoft/vscode#98590
        if (err || (stderr && !stderr.includes('screen size is bogus'))) {
          reject(err ?? new Error(stderr.toString()))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

const cleanUNCPrefix = (value: string): string => {
  if (value.indexOf('\\\\?\\') === 0) {
    return value.substring(4)
  } else if (value.indexOf('\\??\\') === 0) {
    return value.substring(4)
  } else if (value.indexOf('"\\\\?\\') === 0) {
    return '"' + value.substring(5)
  } else if (value.indexOf('"\\??\\') === 0) {
    return '"' + value.substring(5)
  } else {
    return value
  }
}

const JS_FILENAME_PATTERN = /[a-zA-Z-]+\.js\b/g
const UTILITY_NETWORK_HINT = /--utility-sub-type=network/i
const WINDOWS_CRASH_REPORTER = /--crashes-directory/i
const CONPTY = /conhost\.exe.+--headless/i
const TYPE = /--type=([a-zA-Z-]+)/
const TSSERVER = /\b(tsserver|typingsInstaller)\.js\b/i
const RIPGREP = /rg\.exe|[/\\]rg\s/i

export function findName(cmd: string): string {
  if (WINDOWS_CRASH_REPORTER.exec(cmd)) {
    return 'electron-crash-reporter'
  }

  if (CONPTY.exec(cmd)) {
    return 'conpty-agent'
  }

  let matches = TYPE.exec(cmd)
  if (matches && matches.length === 2) {
    const type = matches[1]!
    if (type === 'renderer') {
      return 'window'
    } else if (type === 'utility') {
      if (UTILITY_NETWORK_HINT.exec(cmd)) {
        return 'utility-network-service'
      }
      return 'utility-process'
    } else if (type === 'extensionHost') {
      return 'extension-host'
    }
    return type
  }

  if (TSSERVER.exec(cmd)) {
    return 'tsserver'
  }

  if (RIPGREP.exec(cmd)) {
    return 'ripgrep'
  }

  if (cmd.indexOf('node ') < 0 && cmd.indexOf('node.exe') < 0) {
    let result = ''
    do {
      matches = JS_FILENAME_PATTERN.exec(cmd)
      if (matches) {
        result += matches + ' '
      }
    } while (matches)
    JS_FILENAME_PATTERN.lastIndex = 0

    if (result) {
      return `electron-nodejs (${result.trim()})`
    }
  }

  return cmd
}

interface FlatProcess {
  pid: number
  ppid: number
  cmd: string
  load: number
  mem: number
}

function buildTree(rootPid: number, flat: readonly FlatProcess[]): ProcessItem | undefined {
  const map = new Map<number, ProcessItem>()
  for (const p of flat) {
    map.set(p.pid, {
      name: findName(p.cmd),
      cmd: p.cmd,
      pid: p.pid,
      ppid: p.ppid,
      load: p.load,
      mem: p.mem,
    })
  }

  const rootItem = map.get(rootPid)
  if (!rootItem) {
    return undefined
  }

  for (const item of map.values()) {
    if (item.pid === rootPid) {
      continue
    }
    const parent = map.get(item.ppid)
    if (parent) {
      if (!parent.children) {
        parent.children = []
      }
      parent.children.push(item)
    }
  }

  for (const item of map.values()) {
    if (item.children) {
      item.children.sort((a, b) => a.pid - b.pid)
    }
  }

  return rootItem
}

function applyRoles(item: ProcessItem, roles: ReadonlyMap<number, ProcessRoleInfo>): void {
  const info = roles.get(item.pid)
  if (info) {
    item.role = info.role
    item.name = info.label ? `${info.role} (${info.label})` : info.role
    if (info.label) {
      item.roleLabel = info.label
    }
  }
  item.children?.forEach((child) => applyRoles(child, roles))
}

async function listWindowsProcesses(
  rootPid: number,
  source: WindowsProcessSource,
): Promise<ProcessItem> {
  const list = await source.getProcessList(rootPid)
  const withCpu = await source.getProcessCpuUsage(list)
  const flat: FlatProcess[] = withCpu.map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    cmd: cleanUNCPrefix(p.commandLine ?? ''),
    load: p.cpu ?? 0,
    mem: p.memory ?? 0,
  }))
  const rootItem = buildTree(rootPid, flat)
  if (!rootItem) {
    throw new Error(`Root process ${rootPid} not found`)
  }
  return rootItem
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/

async function listUnixProcesses(
  rootPid: number,
  execPs: () => Promise<string>,
  totalmem: () => number,
): Promise<ProcessItem> {
  const stdout = await execPs()
  const totalMemory = totalmem()
  const flat: FlatProcess[] = []
  for (const line of stdout.split('\n')) {
    const matches = PS_LINE.exec(line.trim())
    if (matches && matches.length === 6) {
      flat.push({
        pid: parseInt(matches[1]!, 10),
        ppid: parseInt(matches[2]!, 10),
        load: parseFloat(matches[3]!),
        mem: (totalMemory * parseFloat(matches[4]!)) / 100,
        cmd: matches[5]!,
      })
    }
  }
  const rootItem = buildTree(rootPid, flat)
  if (!rootItem) {
    throw new Error(`Root process ${rootPid} not found`)
  }
  return rootItem
}

export async function listProcesses(
  rootPid: number,
  roles: ReadonlyMap<number, ProcessRoleInfo>,
  deps: ProcessListDeps = {},
): Promise<ProcessItem> {
  const platform = deps.platform ?? process.platform
  const rootItem =
    platform === 'win32'
      ? await listWindowsProcesses(
          rootPid,
          deps.win ?? defaultWindowsSource(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        )
      : await listUnixProcesses(rootPid, deps.execPs ?? defaultExecPs, deps.totalmem ?? osTotalmem)
  applyRoles(rootItem, roles)
  return rootItem
}

export function formatProcessList(root: ProcessItem): string {
  const lines: string[] = ['CPU %\tMem MB\t   PID\tProcess']
  const visit = (item: ProcessItem, depth: number): void => {
    lines.push(
      `${item.load.toFixed(0).padStart(5, ' ')}\t${(item.mem / MB).toFixed(0).padStart(6, ' ')}\t${String(item.pid).padStart(6, ' ')}\t${'  '.repeat(depth)}${item.name}`,
    )
    item.children?.forEach((child) => visit(child, depth + 1))
  }
  visit(root, 0)
  return lines.join('\n')
}
