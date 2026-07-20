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
 *  No network, no real model: the test only exercises the protocol handshake layer
 *  (initialize / newSession / ext-method parameter + error contracts). It never
 *  sends a real prompt.
 *--------------------------------------------------------------------------------------------*/

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClientSideConnection,
  type Client,
  type InitializeResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'

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
    _meta: { 'universe-editor/ask_user_question': true },
  },
} as const

export interface RealForkConnection {
  readonly conn: ClientSideConnection
  readonly child: ChildProcessWithoutNullStreams
  /** ext-methods the fork received (agent->client direction is recorded here). */
  readonly clientExtMethodCalls: string[]
  /** Tail of the fork's stderr, for failure diagnostics. */
  stderr(): string
  dispose(): void
}

/** Whether both fork dist artifacts exist (i.e. `pnpm agent:build` has run). */
export function forkDistExists(fork: ForkId): boolean {
  return existsSync(FORK_DIST[fork])
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

/**
 * Spawn a fork's dist entry and wrap it in a ClientSideConnection. `cwd` should be
 * a throwaway temp dir (never a real git repo — codex's native binary stalls on
 * `git rev-parse` there). Caller must `dispose()` to kill the child.
 */
export function spawnForkConnection(fork: ForkId, cwd: string): RealForkConnection {
  const entry = FORK_DIST[fork]
  if (!existsSync(entry)) {
    throw new Error(
      `Fork dist not found: ${entry}. Run \`pnpm agent:build\` (needs submodules checked out).`,
    )
  }

  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams

  let stderrTail = ''
  child.stderr.on('data', (d: Buffer) => {
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4096)
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

  return {
    conn,
    child,
    clientExtMethodCalls,
    stderr: () => stderrTail,
    dispose() {
      try {
        child.kill()
      } catch {
        // already gone
      }
    },
  }
}

export { PROTOCOL_VERSION }
export type { InitializeResponse }

/** Reject `p` after `ms`, so a wedged handshake fails the test instead of hanging. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ])
}
