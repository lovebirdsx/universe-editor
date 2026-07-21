import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const EDITOR_PROCESS_NAME = 'UE4Editor.exe'

export interface EditorProcessInfo {
  readonly pid: number
  readonly executablePath: string
  readonly commandLine: string
}

export interface ResolveEditorPidOptions {
  readonly explicitPid?: number
  readonly onLog?: (message: string) => void
}

export async function enumerateEditors(): Promise<readonly EditorProcessInfo[]> {
  if (process.platform !== 'win32') return []

  const script =
    `Get-CimInstance Win32_Process -Filter "Name='${EDITOR_PROCESS_NAME}'" | ` +
    'Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress'

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
    editors.push({
      pid,
      executablePath: typeof record.ExecutablePath === 'string' ? record.ExecutablePath : '',
      commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : '',
    })
  }
  return editors.sort((first, second) => first.pid - second.pid)
}

export async function resolveEditorPid(options: ResolveEditorPidOptions = {}): Promise<number> {
  const { explicitPid, onLog } = options

  const editors = await enumerateEditors()
  if (explicitPid !== undefined) {
    if (editors.some((editor) => editor.pid === explicitPid)) {
      onLog?.(`using explicit editor pid=${explicitPid}`)
      return explicitPid
    }
    throw new Error(
      `指定的 ${EDITOR_PROCESS_NAME} PID ${explicitPid} 不存在，请从 Unreal 重新拉起 Agent。`,
    )
  }

  const first = editors[0]
  if (!first) {
    throw new Error(`未发现正在运行的 ${EDITOR_PROCESS_NAME}，请先启动 Universe Editor。`)
  }

  if (editors.length === 1) {
    onLog?.(`resolved single editor pid=${first.pid}`)
    return first.pid
  }

  throw new Error(
    `检测到 ${editors.length} 个 ${EDITOR_PROCESS_NAME} 进程，但没有指定目标 PID。请从 Unreal 拉起 Agent。`,
  )
}
