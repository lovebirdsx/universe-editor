import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { EditorCommandBridge, EditorMcpVersionMismatchError } from './editorBridge.js'
import { EditorMcpClientKind, type EditorMcpInstanceIdentity } from './protocol.js'

const execFileAsync = promisify(execFile)
const EDITOR_PROCESS_FILTER = "Name='UE4Editor.exe'"

export interface EditorProcessInfo {
  readonly pid: number
  readonly executablePath: string
  readonly commandLine: string
  readonly startTime?: number
}

export interface EditorCandidate {
  readonly identity: EditorMcpInstanceIdentity
  readonly startTime?: number
}

export interface DiscoverEditorsOptions {
  readonly connectTimeoutMs: number
  readonly onLog?: (message: string) => void
  readonly enumerate?: () => Promise<readonly EditorProcessInfo[]>
  readonly probe?: (pid: number) => Promise<EditorMcpInstanceIdentity>
}

export async function enumerateEditors(): Promise<readonly EditorProcessInfo[]> {
  if (process.platform !== 'win32') return []

  const script =
    `Get-CimInstance Win32_Process -Filter "${EDITOR_PROCESS_FILTER}" | ` +
    "Select-Object ProcessId, ExecutablePath, CommandLine, @{Name='CreationDate';Expression={if ($_.CreationDate) {$_.CreationDate.ToString('o')}}} | ConvertTo-Json -Compress"

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10000 },
  )

  const trimmed = stdout.trim()
  if (!trimmed) return []

  const parsed = JSON.parse(trimmed) as unknown
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const editors: EditorProcessInfo[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const pid = Number(record.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const startTime =
      typeof record.CreationDate === 'string' ? Date.parse(record.CreationDate) : NaN
    editors.push({
      pid,
      executablePath: typeof record.ExecutablePath === 'string' ? record.ExecutablePath : '',
      commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
      ...(Number.isFinite(startTime) ? { startTime } : {}),
    })
  }
  return editors.sort((first, second) => first.pid - second.pid)
}

export async function probeEditor(
  pid: number,
  connectTimeoutMs: number,
): Promise<EditorMcpInstanceIdentity> {
  const bridge = new EditorCommandBridge({
    editorPid: pid,
    timeoutMs: connectTimeoutMs,
    connectTimeoutMs,
    clientKind: EditorMcpClientKind.McpProbe,
  })
  try {
    await bridge.start()
    return bridge.identity
  } finally {
    await bridge.stop()
  }
}

export async function discoverEditors(
  options: DiscoverEditorsOptions,
): Promise<readonly EditorCandidate[]> {
  const editors = await (options.enumerate ?? enumerateEditors)()
  if (!editors.length) throw new Error('未发现正在运行的 UE4Editor，请先启动 UE4Editor。')

  const probe =
    options.probe ?? ((pid: number) => probeEditor(pid, Math.min(options.connectTimeoutMs, 2000)))
  const candidates: EditorCandidate[] = []
  let hasVersionMismatch = false
  for (let offset = 0; offset < editors.length; offset += 8) {
    await Promise.all(
      editors.slice(offset, offset + 8).map(async (editor) => {
        try {
          const identity = await probe(editor.pid)
          if (identity.EditorPid !== editor.pid) throw new Error('握手 PID 与进程不一致')
          candidates.push({
            identity,
            ...(editor.startTime !== undefined ? { startTime: editor.startTime } : {}),
          })
        } catch (error) {
          if (error instanceof EditorMcpVersionMismatchError) hasVersionMismatch = true
          options.onLog?.(
            `UE pid=${editor.pid} MCP probe failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }),
    )
  }
  if (!candidates.length) {
    if (hasVersionMismatch) {
      throw new EditorMcpVersionMismatchError()
    }
    throw new Error('检测到 UE4Editor 进程，但没有可连接的 MCP 服务；请确认可视化编辑器已启动。')
  }
  return candidates.sort((first, second) => first.identity.EditorPid - second.identity.EditorPid)
}
