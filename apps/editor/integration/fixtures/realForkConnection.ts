/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Real-subprocess ACP connection helper for the cross-repo contract test.
 *
 *  Unlike inMemoryAcpPair (which loops messages between two in-process SDK peers),
 *  this spawns the ACTUAL built fork dist (vendor/<fork>/dist/index.js) with the
 *  system node — the same entry the editor launches in production via
 *  ELECTRON_RUN_AS_NODE — and drives it over a real stdio ndJsonStream. That is the
 *  only way to catch a wire-shape drift between the editor's SDK version and the
 *  fork's (they intentionally differ), which "keep both in sync" comments cannot.
 *
 *  Only the protocol handshake layer is exercised (initialize / newSession /
 *  ext-method parameter + error contracts); no prompt is ever sent, so no model is
 *  invoked.
 *
 *  codex 连接在调用方临时 cwd 下拿到独立的 CODEX_HOME（只覆盖这一个环境变量），
 *  因此不会读取开发者真实的 ~/.codex（账号、会话、sqlite 状态）。
 *--------------------------------------------------------------------------------------------*/

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClientSideConnection,
  type Client,
  type InitializeResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { removeDirWithRetry } from '@universe-editor/temp-root'

const __dirname = dirname(fileURLToPath(import.meta.url))
// integration/fixtures → repo root is five levels up (apps/editor/integration/fixtures).
const repoRoot = resolve(__dirname, '..', '..', '..', '..')

export type ForkId = 'claude' | 'codex'

const FORK_DIST: Record<ForkId, string> = {
  claude: resolve(repoRoot, 'vendor/claude-agent-acp/dist/index.js'),
  codex: resolve(repoRoot, 'vendor/codex-acp/dist/index.js'),
}

/** The init params the editor sends in production (mirrors DEFAULT_INIT_PARAMS). */
export const CLIENT_INIT_PARAMS = {
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
    auth: { terminal: true, _meta: { 'terminal-auth': true } },
    elicitation: { form: {}, url: {} },
  },
} as const

export interface RealForkConnection {
  readonly conn: ClientSideConnection
  readonly child: ChildProcessWithoutNullStreams
  /** ext-methods the fork received (agent->client direction is recorded here). */
  readonly clientExtMethodCalls: string[]
  /** 该连接 spawn 时用的独立 CODEX_HOME（codex 才有），建在调用方 cwd 下。 */
  readonly codexHome: string | undefined
  /** Tail of the fork's stderr, for failure diagnostics. */
  stderr(): string
  /** 杀子进程、有界等待真正 close、再删独立 CODEX_HOME；幂等（重复/并发调用共享同一次）。 */
  dispose(): Promise<void>
}

export interface SpawnForkOptions {
  /** 覆盖 spawn 的入口脚本；fixture 自身测试指向 stub，绝不启动真实 fork。 */
  entry?: string
}

/** Whether both fork dist artifacts exist (i.e. `pnpm agent:build` has run). */
export function forkDistExists(fork: ForkId): boolean {
  return existsSync(FORK_DIST[fork])
}

/**
 * The built dist bundle text for a fork. The ext-method wire names survive
 * esbuild as plain string literals, so scanning this text is a cheap OFFLINE
 * proxy for "does the fork still declare the method name the editor expects" —
 * the CI-runnable equivalent of the live rewind/set_title routing probe, which
 * needs a real Claude binary and thus self-skips on CI.
 */
export function readForkDist(fork: ForkId): string {
  return readFileSync(FORK_DIST[fork], 'utf8')
}

/**
 * Whether a real Claude native binary is reachable via `CLAUDE_CODE_EXECUTABLE`.
 *
 * The claude fork's `session/new` eagerly spawns the Claude CLI (the SDK's
 * `query()` launches it at session creation, not lazily at first prompt), so the
 * ext-method routing suite — which needs a live session to route
 * rewind/set_title against — only runs when a working binary is present. The
 * offline core of the contract (the ext-method NAME table + the initialize
 * handshake) has no such dependency and always runs.
 */
export function claudeBinaryAvailable(): boolean {
  const p = process.env.CLAUDE_CODE_EXECUTABLE
  return typeof p === 'string' && p.length > 0 && existsSync(p)
}

/** SIGTERM 宽限；超时升级 SIGKILL，再给一段宽限。 */
const SIGTERM_GRACE_MS = 2_000
const SIGKILL_GRACE_MS = 1_000

/** 在调用方临时 cwd 下为单个连接建独立 CODEX_HOME；只覆盖 CODEX_HOME，其余环境继承。 */
function createIsolatedCodexHome(cwd: string): string {
  const home = mkdtempSync(join(cwd, 'codex-home-'))
  try {
    // 凭据固定存文件，避免 app-server 去碰系统 keychain。
    writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf8')
  } catch (err) {
    removeDirWithRetry(home)
    throw err
  }
  return home
}

export interface ChildCloseTracker {
  readonly closed: boolean
  readonly whenClosed: Promise<void>
}

/** spawn 后立即调用：close 事件早于 dispose 到达也不会丢。 */
function trackChildClose(child: ChildProcessWithoutNullStreams): ChildCloseTracker {
  let closed = child.exitCode !== null || child.signalCode !== null
  let resolveClosed: () => void = () => {}
  const whenClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  if (closed) resolveClosed()
  else
    child.once('close', () => {
      closed = true
      resolveClosed()
    })
  return {
    get closed() {
      return closed
    },
    whenClosed,
  }
}

/** 有界等待 close；超时返回 false。 */
function waitForClose(tracker: ChildCloseTracker, ms: number): Promise<boolean> {
  if (tracker.closed) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void tracker.whenClosed.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * SIGTERM → 超时 SIGKILL → 仍未 close 则抛错并保留 home（进程还在时删目录只会留下半删状态）。
 * 导出以便单测构造「永不 close 的假 child」，无需真等宽限超时。
 */
export async function shutdownChild(
  child: ChildProcessWithoutNullStreams,
  tracker: ChildCloseTracker,
  codexHome: string | undefined,
): Promise<void> {
  if (!tracker.closed) {
    child.kill('SIGTERM')
    if (!(await waitForClose(tracker, SIGTERM_GRACE_MS))) {
      child.kill('SIGKILL')
      if (!(await waitForClose(tracker, SIGKILL_GRACE_MS))) {
        throw new Error(
          `Fork child still alive ${SIGKILL_GRACE_MS}ms after SIGKILL; keeping ${codexHome ?? '(no)'} home`,
        )
      }
    }
  }
  if (codexHome !== undefined) removeDirWithRetry(codexHome)
}

/**
 * Spawn a fork's dist entry and wrap it in a ClientSideConnection. `cwd` should be
 * a throwaway temp dir (never a real git repo — codex's native binary stalls on
 * `git rev-parse` there). Caller must `await dispose()` to kill the child.
 */
export function spawnForkConnection(
  fork: ForkId,
  cwd: string,
  options: SpawnForkOptions = {},
): RealForkConnection {
  const entry = options.entry ?? FORK_DIST[fork]
  if (!existsSync(entry)) {
    throw new Error(
      `Fork dist not found: ${entry}. Run \`pnpm agent:build\` (needs submodules checked out).`,
    )
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  let codexHome: string | undefined
  let child: ChildProcessWithoutNullStreams
  try {
    if (fork === 'codex') {
      codexHome = createIsolatedCodexHome(cwd)
      env['CODEX_HOME'] = codexHome
    }
    child = spawn(process.execPath, [entry], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }) as ChildProcessWithoutNullStreams
  } catch (err) {
    if (codexHome !== undefined) removeDirWithRetry(codexHome)
    throw err
  }

  const closeTracker = trackChildClose(child)

  let stderrTail = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4096)
  })
  // spawn error 只记诊断，不作为「已 close」的依据（close 由 closeTracker 跟踪）。
  child.on('error', (err: Error) => {
    stderrTail = (stderrTail + `\n[spawn error] ${String(err)}`).slice(-4096)
  })

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((res, rej) => {
        child.stdin.write(chunk, (err) => (err ? rej(err) : res()))
      })
    },
  })
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      child.stdout.on('data', (d: Buffer) => controller.enqueue(new Uint8Array(d)))
      child.stdout.on('end', () => {
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })
  const stream = ndJsonStream(writable, readable)

  const clientExtMethodCalls: string[] = []
  const client: Client = {
    async requestPermission() {
      return { outcome: { outcome: 'cancelled' } }
    },
    async sessionUpdate() {},
    async writeTextFile() {
      return {}
    },
    async readTextFile() {
      return { content: '' }
    },
    async extMethod(method: string) {
      clientExtMethodCalls.push(method)
      return {}
    },
  }
  const conn = new ClientSideConnection(() => client, stream)

  let disposePromise: Promise<void> | undefined
  return {
    conn,
    child,
    clientExtMethodCalls,
    codexHome,
    stderr: () => stderrTail,
    dispose() {
      disposePromise ??= shutdownChild(child, closeTracker, codexHome)
      return disposePromise
    },
  }
}

export { PROTOCOL_VERSION }
export type { InitializeResponse }

/** Reject `p` after `ms`, so a wedged handshake fails the test instead of hanging. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
