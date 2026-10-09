/*---------------------------------------------------------------------------------------------
 *  WSLg dev 环境下的 Electron Wayland 注入。
 *
 *  背景：WSLg 的 RDP 层会吃掉宿主的 DPI 缩放（宿主机 125% 时 weston 对 Linux 应用
 *  报告 scale=1，分辨率也是缩放后的有效值）。Electron 默认走 X11/XWayland，X11 无
 *  DPI 概念，Chromium 按 scale=1 低分辨率渲染再被合成器拉伸——表现为窗口比宿主
 *  应用小、整体模糊。改走原生 Wayland 后端后，Chromium 经 fractional-scale 协议
 *  拿到宿主真实缩放，尺寸与清晰度恢复正常。
 *
 *  但 WAYLAND_DISPLAY 存在**不等于** socket 可连：WSLg 的 wayland-0 只落在
 *  /mnt/wslg/runtime-dir，靠 WSL 把它 bind 到 $XDG_RUNTIME_DIR（/run/user/$UID）。
 *  这个 bind 会丢——实例重启后若没有 login session，user-runtime-dir@.service 不跑，
 *  /run/user/$UID 压根不存在，而 WSLg 注入的环境变量仍在。照旧注入就是
 *  `Failed to initialize Wayland platform. Exiting.`（SIGTRAP，exit 133）启动即崩。
 *  所以注入前先 connect 一次探测，探测不过回退 X11 并置 degraded（调用方据此提示
 *  「窗口会糊」）——宁可糊，不要崩。
 *
 *  用法（dev.mjs / dev-run.mjs 共用，须在 loadEnv() 之后调用）:
 *    import { wslElectronArgs } from '../../../scripts/lib/wslElectronArgs.mjs'
 *    const wsl = await wslElectronArgs()
 *    // wsl.active → 把 wsl.args 拼进 electron 的 argv
 *    // !wsl.active && wsl.degraded → 打一行降级提示（原因见 wsl.reason）
 *
 *  逃生口：UNIVERSE_WSL_WAYLAND=0 强制关闭（shell 或 .env.local 均可）。
 *  Windows / macOS / 原生 Linux 恒不生效。
 *--------------------------------------------------------------------------------------------*/

import { connect } from 'node:net'
import { join } from 'node:path'

export const WSL_WAYLAND_ARGS = [
  '--ozone-platform=wayland',
  '--enable-features=WaylandWindowDecorations',
]

const PROBE_TIMEOUT_MS = 300

/** 复刻 libwayland 的 socket 解析：WAYLAND_DISPLAY 为绝对路径时直接用，否则拼 $XDG_RUNTIME_DIR。 */
export function waylandSocketPath(env) {
  const name = env.WAYLAND_DISPLAY
  if (!name) return null
  if (name.startsWith('/')) return name
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, name) : null
}

/** connect 一次即断：只验证有监听者，不发送任何 Wayland 协议字节。 */
function probeSocket(path, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let socket
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket?.destroy()
      resolve(ok)
    }
    try {
      socket = connect(path)
    } catch {
      resolve(false)
      return
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

export async function wslElectronArgs({
  platform = process.platform,
  env = process.env,
  probe = probeSocket,
} = {}) {
  if (platform !== 'linux') return { active: false, args: [], reason: 'not linux' }
  if (env.UNIVERSE_WSL_WAYLAND === '0') {
    return { active: false, args: [], reason: 'UNIVERSE_WSL_WAYLAND=0' }
  }
  if (!env.WSL_DISTRO_NAME && !env.WSL_INTEROP)
    return { active: false, args: [], reason: 'not WSL' }
  // 没有 Wayland 合成器时（headless WSL / SSH 会话）传 wayland flag 会启动即失败
  if (!env.WAYLAND_DISPLAY) {
    return { active: false, args: [], reason: 'WSL but no WAYLAND_DISPLAY' }
  }
  // 检测链到此为止都是「变量看着对」；下面这一层才验证 socket 真能连上（见头注释）。
  const socketPath = waylandSocketPath(env)
  if (!socketPath || !(await probe(socketPath))) {
    const detail = socketPath ?? `no XDG_RUNTIME_DIR for WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}`
    return {
      active: false,
      args: [],
      reason: `wayland socket unreachable: ${detail}`,
      degraded: true,
    }
  }
  return { active: true, args: WSL_WAYLAND_ARGS, reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` }
}
