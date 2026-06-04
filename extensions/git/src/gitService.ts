/**
 * Thin wrapper over the `git` CLI. Every call is `spawn('git', argv)` with an
 * argument array — never a shell string — so paths and messages can't inject
 * shell syntax. The child env is sanitized the same way the main process
 * sanitizes the extension host's: the ELECTRON_* / NODE_OPTIONS denylist is
 * stripped so a Node-shaped child can't be steered, even though `git` itself
 * isn't Node.
 */
import { spawn } from 'node:child_process'

export interface GitExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Same rationale as the host spawner — see extensionHostMainService. */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

function sanitizeEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Run `git <args>` in `cwd`. Resolves with stdout/stderr/exitCode regardless of
 * the exit code (callers decide what a non-zero code means); rejects only if the
 * process can't be spawned at all (e.g. git not installed). Output is collected
 * as bytes and decoded as UTF-8 so NUL-delimited `-z` output survives intact.
 */
export function gitExec(args: readonly string[], cwd: string): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [...args], {
      cwd,
      env: sanitizeEnv(),
      windowsHide: true,
      shell: false,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    proc.on('error', reject)
    proc.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code ?? 0,
      })
    })
  })
}

/** Absolute path of the repository containing `cwd`, or undefined if none. */
export async function detectRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const res = await gitExec(['rev-parse', '--show-toplevel'], cwd)
    if (res.exitCode !== 0) return undefined
    return res.stdout.trim() || undefined
  } catch {
    return undefined
  }
}
