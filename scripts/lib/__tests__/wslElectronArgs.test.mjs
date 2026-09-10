/*---------------------------------------------------------------------------------------------
 *  scripts/lib/wslElectronArgs.mjs 单测：四层检测链决策表。
 *  纯函数注入 { platform, env }，不触碰真实 process.env。
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WSL_WAYLAND_ARGS, wslElectronArgs } from '../wslElectronArgs.mjs'

const WSLG_ENV = {
  WSL_DISTRO_NAME: 'Ubuntu-24.04',
  WSL_INTEROP: '/run/WSL/1_interop',
  WAYLAND_DISPLAY: 'wayland-0',
}

test('WSL + Wayland 合成器 → 注入 flags', () => {
  const r = wslElectronArgs({ platform: 'linux', env: WSLG_ENV })
  assert.equal(r.active, true)
  assert.deepEqual(r.args, WSL_WAYLAND_ARGS)
  assert.match(r.reason, /wayland-0/)
})

test('非 linux 平台恒不生效', () => {
  for (const platform of ['win32', 'darwin']) {
    const r = wslElectronArgs({ platform, env: WSLG_ENV })
    assert.equal(r.active, false)
    assert.equal(r.reason, 'not linux')
    assert.deepEqual(r.args, [])
  }
})

test('UNIVERSE_WSL_WAYLAND=0 逃生口优先于其它条件', () => {
  const r = wslElectronArgs({ platform: 'linux', env: { ...WSLG_ENV, UNIVERSE_WSL_WAYLAND: '0' } })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'UNIVERSE_WSL_WAYLAND=0')
})

test('非 0 的 UNIVERSE_WSL_WAYLAND 值不视为关闭', () => {
  const r = wslElectronArgs({ platform: 'linux', env: { ...WSLG_ENV, UNIVERSE_WSL_WAYLAND: '1' } })
  assert.equal(r.active, true)
})

test('非 WSL 的原生 Linux 不生效', () => {
  const r = wslElectronArgs({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'not WSL')
})

test('WSL_DISTRO_NAME 或 WSL_INTEROP 任一存在即视为 WSL', () => {
  for (const env of [
    { WSL_DISTRO_NAME: 'Ubuntu-24.04', WAYLAND_DISPLAY: 'wayland-0' },
    { WSL_INTEROP: '/run/WSL/1_interop', WAYLAND_DISPLAY: 'wayland-0' },
  ]) {
    assert.equal(wslElectronArgs({ platform: 'linux', env }).active, true)
  }
})

test('WSL 但无 WAYLAND_DISPLAY（headless / SSH）不生效', () => {
  const r = wslElectronArgs({
    platform: 'linux',
    env: { WSL_DISTRO_NAME: 'Ubuntu-24.04', WSL_INTEROP: '/run/WSL/1_interop' },
  })
  assert.equal(r.active, false)
  assert.equal(r.reason, 'WSL but no WAYLAND_DISPLAY')
})
