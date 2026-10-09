/*---------------------------------------------------------------------------------------------
 *  scripts/lib/wslElectronArgs.mjs 单测：五层检测链决策表 + socket 探测层。
 *  决策表注入 { platform, env, probe }，不触碰真实 process.env；探测层用临时目录里的
 *  真实 unix socket 验证（本次故障的复现：变量齐全但 socket 不存在 → 必须回退 X11）。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { WSL_WAYLAND_ARGS, waylandSocketPath, wslElectronArgs } from '../wslElectronArgs.mjs'
import { mkTempDir, removeDirWithRetry } from '../temp-root.mjs'

const WSLG_ENV = {
  WSL_DISTRO_NAME: 'Ubuntu-24.04',
  WSL_INTEROP: '/run/WSL/1_interop',
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_RUNTIME_DIR: '/run/user/1000',
}

const reachable = { probe: async () => true }

// 起一个真的在听 wayland-0 的 unix socket。probeSocket 只 connect 不发字节，
// 所以空 server 就够——它验证的正是「有监听者」这一条。
async function listenWaylandSocket(t, env) {
  const dir = mkTempDir('ue-')
  const socketPath = join(dir, 'wayland-0')
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  t.after(() => {
    server.close()
    removeDirWithRetry(dir)
  })
  return { dir, socketPath, env: { ...env, XDG_RUNTIME_DIR: dir } }
}

test('WSL + Wayland 合成器 + socket 可连 → 注入 flags', async () => {
  const r = await wslElectronArgs({ platform: 'linux', env: WSLG_ENV, ...reachable })
  assert.equal(r.active, true)
  assert.deepEqual(r.args, WSL_WAYLAND_ARGS)
  assert.match(r.reason, /wayland-0/)
})

test('非 linux 平台恒不生效', async () => {
  for (const platform of ['win32', 'darwin']) {
    const r = await wslElectronArgs({ platform, env: WSLG_ENV, ...reachable })
    assert.equal(r.active, false)
    assert.equal(r.reason, 'not linux')
    assert.deepEqual(r.args, [])
  }
})

test('UNIVERSE_WSL_WAYLAND=0 逃生口优先于其它条件', async () => {
  const r = await wslElectronArgs({
    platform: 'linux',
    env: { ...WSLG_ENV, UNIVERSE_WSL_WAYLAND: '0' },
    ...reachable,
  })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'UNIVERSE_WSL_WAYLAND=0')
})

test('非 0 的 UNIVERSE_WSL_WAYLAND 值不视为关闭', async () => {
  const r = await wslElectronArgs({
    platform: 'linux',
    env: { ...WSLG_ENV, UNIVERSE_WSL_WAYLAND: '1' },
    ...reachable,
  })
  assert.equal(r.active, true)
})

test('非 WSL 的原生 Linux 不生效', async () => {
  const r = await wslElectronArgs({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    ...reachable,
  })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'not WSL')
})

test('WSL_DISTRO_NAME 或 WSL_INTEROP 任一存在即视为 WSL', async () => {
  for (const env of [
    {
      WSL_DISTRO_NAME: 'Ubuntu-24.04',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
    },
    {
      WSL_INTEROP: '/run/WSL/1_interop',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_RUNTIME_DIR: '/run/user/1000',
    },
  ]) {
    assert.equal((await wslElectronArgs({ platform: 'linux', env, ...reachable })).active, true)
  }
})

test('WSL 但无 WAYLAND_DISPLAY（headless / SSH）不生效', async () => {
  const r = await wslElectronArgs({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WSL_INTEROP: '/run/WSL/1_interop' },
    ...reachable,
  })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'WSL but no WAYLAND_DISPLAY')
})

test('WSLg 变量齐全但 socket 不存在 → 回退 X11 且标记 degraded', async () => {
  // 事故复现：/run/user/1000 整个目录缺失（user-runtime-dir@.service 没跑），
  // WAYLAND_DISPLAY 仍在——照旧注入就是 Electron 启动即崩（exit 133）。
  const dir = mkTempDir('ue-')
  try {
    const r = await wslElectronArgs({
      platform: 'linux',
      env: { ...WSLG_ENV, XDG_RUNTIME_DIR: dir },
    })
    assert.equal(r.active, false)
    assert.deepEqual(r.args, [])
    assert.equal(r.degraded, true)
    assert.match(r.reason, /wayland socket unreachable/)
  } finally {
    removeDirWithRetry(dir)
  }
})

test('相对 WAYLAND_DISPLAY + 无 XDG_RUNTIME_DIR → 回退且 degraded', async () => {
  const r = await wslElectronArgs({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WAYLAND_DISPLAY: 'wayland-0' },
  })
  assert.equal(r.active, false)
  assert.equal(r.degraded, true)
  assert.match(r.reason, /no XDG_RUNTIME_DIR/)
})

test(
  'socket 真实可连 → 注入（真实 connect 探测）',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { env } = await listenWaylandSocket(t, WSLG_ENV)
    const r = await wslElectronArgs({ platform: 'linux', env })
    assert.equal(r.active, true)
    assert.deepEqual(r.args, WSL_WAYLAND_ARGS)
    assert.equal(r.degraded, undefined)
  },
)

test(
  'WAYLAND_DISPLAY 是绝对路径时不需要 XDG_RUNTIME_DIR',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const { socketPath } = await listenWaylandSocket(t, {})
    const r = await wslElectronArgs({
      platform: 'linux',
      env: {
        WSL_DISTRO_NAME: 'Ubuntu-24.04',
        WAYLAND_DISPLAY: socketPath,
      },
    })
    assert.equal(r.active, true)
  },
)

test('正常跳过（非 WSL / 无合成器 / 逃生口）不标记 degraded', async () => {
  const cases = [
    { platform: 'win32', env: WSLG_ENV },
    { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } },
    { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' } },
    { platform: 'linux', env: { ...WSLG_ENV, UNIVERSE_WSL_WAYLAND: '0' } },
  ]
  for (const c of cases) {
    assert.equal((await wslElectronArgs(c)).degraded, undefined)
  }
})

test('waylandSocketPath: 绝对路径原样 / 相对路径拼 runtime dir / 缺变量返回 null', () => {
  assert.equal(waylandSocketPath({ WAYLAND_DISPLAY: '/tmp/w' }), '/tmp/w')
  assert.equal(
    waylandSocketPath({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' }),
    join('/run/user/1000', 'wayland-0'),
  )
  assert.equal(waylandSocketPath({ WAYLAND_DISPLAY: 'wayland-0' }), null)
  assert.equal(waylandSocketPath({}), null)
})
